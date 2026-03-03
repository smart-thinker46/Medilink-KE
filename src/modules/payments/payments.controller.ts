import { Controller, Get, Post, Body, UseGuards, Req, Query, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { mergeProfileExtras } from 'src/common/profile-extras';
import { MpesaService } from './mpesa.service';
import { EmailsService } from '../emails/emails.service';
import { ConfigService } from '@nestjs/config';
import { IntaSendService } from './intasend.service';

@Controller('payments')
@UseGuards(AuthGuard('jwt'))
export class PaymentsController {
  constructor(
    private mpesa: MpesaService,
    private intasend: IntaSendService,
    private config: ConfigService,
    private emails: EmailsService,
    private prisma: PrismaService,
  ) {}

  private getUsdKesRate() {
    const raw = this.config.get<string>('USD_KES_RATE') || this.config.get<string>('EXCHANGE_RATE_USD_KES');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 150;
  }

  private normalizeCurrency(value?: string) {
    const currency = String(value || 'KES').toUpperCase();
    return currency === 'USD' ? 'USD' : 'KES';
  }

  private get paymentsSandboxMode() {
    return String(this.config.get('PAYMENTS_SANDBOX_MODE') || 'false') === 'true';
  }

  private get sandboxAutoPayEnabled() {
    return String(this.config.get('SANDBOX_ALLOW_AUTOPAY') || 'false') === 'true';
  }

  private canAutoMarkPaid(req: any) {
    return this.paymentsSandboxMode && this.sandboxAutoPayEnabled && req?.user?.role === 'SUPER_ADMIN';
  }

  private emitCheckoutCompleteEvent(order: any, payment: any) {
    if (!order) return;
    InMemoryStore.create('pharmacyEvents', {
      pharmacyId: order?.pharmacyId || payment?.recipientId || null,
      type: 'CHECKOUT_COMPLETE',
      userId: order?.buyerId || order?.patientId || payment?.userId || null,
      orderId: order?.id || payment?.orderId || null,
      metadata: {
        status: 'PAID',
        total: order?.total ?? payment?.amount ?? 0,
        currency: order?.currency || payment?.currency || 'KES',
        paymentId: payment?.id || null,
      },
      createdAt: new Date().toISOString(),
    });
  }

  private async sendPaymentNotifications(payment: any) {
    if (!payment) return;

    await this.emails.sendPaymentReceipt(payment).catch(() => undefined);

    if (String(payment?.type || '').toUpperCase() === 'SUBSCRIPTION' && payment?.payerEmail) {
      await this.emails
        .sendSubscriptionSuccess({
          to: payment.payerEmail,
          plan: payment?.plan || 'monthly',
          amount: payment?.amount || 0,
          currency: payment?.currency || 'KES',
          locale: 'en',
        })
        .catch(() => undefined);
    }

    const recipientId = String(payment?.recipientId || '').trim();
    if (!recipientId) return;

    const recipientEmails = new Set<string>();
    const recipientUser = await this.prisma.user
      .findUnique({
        where: { id: recipientId },
        select: { email: true },
      })
      .catch(() => null);
    if (recipientUser?.email) recipientEmails.add(recipientUser.email);

    const recipientTenant = await this.prisma.tenant
      .findUnique({
        where: { id: recipientId },
        select: { email: true },
      })
      .catch(() => null);
    if (recipientTenant?.email) recipientEmails.add(recipientTenant.email);

    if (recipientEmails.size === 0) return;

    await Promise.allSettled(
      Array.from(recipientEmails).map((email) =>
        this.emails.sendPaymentReceived({
          to: email,
          amount: payment?.amount || 0,
          currency: payment?.currency || 'KES',
          description: payment?.description || 'Payment',
          locale: 'en',
        }),
      ),
    );
  }

  private normalizeMoney(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeStatus(value: unknown) {
    return String(value || '').trim().toUpperCase();
  }

  private async resolveWalletOwnerId(req: any, requestedOwnerId?: string) {
    const role = String(req?.user?.role || '').trim().toUpperCase();
    const userId = String(req?.user?.userId || '').trim();
    const ownerId = String(requestedOwnerId || '').trim();

    if (!userId) {
      throw new ForbiddenException('Unauthenticated request.');
    }

    if (role === 'SUPER_ADMIN') {
      return ownerId || userId;
    }

    if (role === 'MEDIC') {
      if (ownerId && ownerId !== userId) {
        throw new ForbiddenException('You can only access your own wallet.');
      }
      return userId;
    }

    if (role === 'PHARMACY_ADMIN' || role === 'HOSPITAL_ADMIN') {
      if (!ownerId) {
        throw new BadRequestException('ownerId is required for this wallet.');
      }
      const tenantLink = await this.prisma.tenantUser.findFirst({
        where: { tenantId: ownerId, userId },
        select: { id: true },
      });
      if (!tenantLink) {
        throw new ForbiddenException('You are not allowed to access this wallet.');
      }
      return ownerId;
    }

    throw new ForbiddenException('Wallet is available only for medic and facility accounts.');
  }

  private buildWalletSnapshot(ownerId: string) {
    const payments = (InMemoryStore.list('payments') as any[])
      .filter((item) => String(item?.recipientId || '') === ownerId)
      .sort(
        (a, b) =>
          new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime(),
      );

    const withdrawals = (InMemoryStore.list('withdrawals') as any[])
      .filter((item) => String(item?.ownerId || '') === ownerId)
      .sort(
        (a, b) =>
          new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime(),
      );

    const paidPayments = payments.filter(
      (item) => this.normalizeStatus(item?.status) === 'PAID',
    );
    const pendingPayments = payments.filter((item) => {
      const status = this.normalizeStatus(item?.status);
      return status === 'PENDING' || status === 'PROCESSING';
    });
    const failedPayments = payments.filter((item) => {
      const status = this.normalizeStatus(item?.status);
      return status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED' || status === 'CANCELED';
    });

    const totalReceived = paidPayments.reduce(
      (sum, item) => sum + this.normalizeMoney(item?.amount),
      0,
    );
    const pendingBalance = pendingPayments.reduce(
      (sum, item) => sum + this.normalizeMoney(item?.amount),
      0,
    );

    const reservedStatuses = new Set(['REQUESTED', 'APPROVED', 'PROCESSING']);
    const reservedAmount = withdrawals
      .filter((item) => reservedStatuses.has(this.normalizeStatus(item?.status)))
      .reduce((sum, item) => sum + this.normalizeMoney(item?.amount), 0);
    const withdrawnAmount = withdrawals
      .filter((item) => this.normalizeStatus(item?.status) === 'COMPLETED')
      .reduce((sum, item) => sum + this.normalizeMoney(item?.amount), 0);
    const availableBalance = Math.max(0, totalReceived - reservedAmount - withdrawnAmount);

    return {
      summary: {
        ownerId,
        currency: 'KES',
        availableBalance: Number(availableBalance.toFixed(2)),
        pendingBalance: Number(pendingBalance.toFixed(2)),
        totalReceived: Number(totalReceived.toFixed(2)),
        totalTransactions: payments.length,
        paidTransactions: paidPayments.length,
        pendingTransactions: pendingPayments.length,
        failedTransactions: failedPayments.length,
        totalWithdrawals: Number((reservedAmount + withdrawnAmount).toFixed(2)),
      },
      transactions: payments.slice(0, 20),
      withdrawals: withdrawals.slice(0, 20),
    };
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const isVideoCall = body.type === 'VIDEO_CALL';
    const amount = Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    const now = new Date().toISOString();
    const receiptNumber = `MLK-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const description =
      body.description ||
      (body.type === 'SUBSCRIPTION'
        ? 'Subscription'
        : isVideoCall
          ? 'Video Call'
          : 'Payment');
    const currency = this.normalizeCurrency(body.currency);
    const payment = InMemoryStore.create('payments', {
      userId: req.user?.userId,
      payerEmail: req.user?.email,
      payerRole: req.user?.role,
      amount,
      currency,
      method: 'intasend',
      type: body.type || 'PAYMENT',
      description,
      plan: body.plan,
      recipientId: body.recipientId,
      recipientRole: body.recipientRole,
      orderId: body.orderId,
      // Never trust client-provided payment status.
      status: 'PENDING',
      minutes: body.minutes,
      receiptNumber,
      invoiceNumber: receiptNumber,
      receiptIssuedAt: now,
      createdAt: now,
    });

    if (this.canAutoMarkPaid(req)) {
      payment.status = 'PAID';
      payment.updatedAt = new Date().toISOString();
      await this.sendPaymentNotifications(payment);
      if (payment.type === 'SUBSCRIPTION') {
        InMemoryStore.create('subscriptions', {
          userId: payment.userId,
          role: payment.payerRole,
          plan: payment.plan || 'monthly',
          amount: payment.amount,
          currency: payment.currency,
          status: 'ACTIVE',
          startedAt: new Date().toISOString(),
        });
        await mergeProfileExtras(this.prisma, payment.userId, {
          subscriptionActive: true,
          premiumActive: true,
        });
      }
      if (payment.type === 'ORDER' && payment.orderId) {
        const updatedOrder = InMemoryStore.update('orders', payment.orderId, {
          status: 'PAID',
          paymentId: payment.id,
          updatedAt: new Date().toISOString(),
        });
        this.emitCheckoutCompleteEvent(updatedOrder, payment);
      }
      return payment;
    }

    try {
      const checkout = await this.intasend.createCheckout({
        amount,
        currency,
        email: req.user?.email,
        phone: body.phone || req.user?.phone,
        apiRef: payment.id,
        description,
      });
      payment.gateway = 'INTASEND';
      payment.checkoutUrl = checkout.checkoutUrl;
      payment.gatewayReference = checkout.gatewayReference;
      payment.gatewayResponse = checkout.raw;
      payment.apiRef = payment.id;
      payment.updatedAt = new Date().toISOString();

      if (!payment.checkoutUrl) {
        throw new BadRequestException(
          'IntaSend did not return a checkout URL. Please verify gateway configuration.',
        );
      }
    } catch (error: any) {
      payment.status = 'FAILED';
      payment.gateway = 'INTASEND';
      payment.gatewayError = error?.message || 'IntaSend checkout failed';
      payment.updatedAt = new Date().toISOString();
      throw error;
    }

    return payment;
  }

  @Post('mpesa/stk-push')
  async stkPush(@Req() req: any, @Body() body: any) {
    const now = new Date().toISOString();
    const receiptNumber = `MLK-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const description = body.description || 'M-Pesa Payment';
    const currency = this.normalizeCurrency(body.currency);
    const usdKesRate = this.getUsdKesRate();
    const originalAmount = Number(body.amount || 0);
    if (!originalAmount || originalAmount <= 0) {
      throw new BadRequestException('amount is required');
    }
    const amountKes = currency === 'USD' ? Math.ceil(originalAmount * usdKesRate) : originalAmount;
    const payment = InMemoryStore.create('payments', {
      userId: req.user?.userId,
      payerEmail: req.user?.email,
      payerRole: req.user?.role,
      amount: originalAmount,
      currency,
      chargedAmount: amountKes,
      chargedCurrency: 'KES',
      fxRate: currency === 'USD' ? usdKesRate : null,
      method: 'mpesa',
      type: body.type || 'PAYMENT',
      description,
      plan: body.plan,
      recipientId: body.recipientId,
      recipientRole: body.recipientRole,
      orderId: body.orderId,
      status: 'PENDING',
      minutes: body.minutes,
      receiptNumber,
      invoiceNumber: receiptNumber,
      receiptIssuedAt: now,
      createdAt: now,
    });

    const requesterId = req.user?.userId as string | undefined;
    const requester =
      !body.phone && requesterId
        ? await this.prisma.user.findUnique({
            where: { id: requesterId },
            select: { phone: true },
          })
        : null;
    const phone = body.phone || requester?.phone;
    if (!phone) {
      throw new BadRequestException(
        'Phone number is required for M-Pesa STK push. Provide phone in request body or update your profile phone.',
      );
    }

    const response = await this.mpesa.stkPush({
      amount: amountKes,
      phone,
      accountReference: body.accountReference || receiptNumber,
      description,
      callbackUrl: body.callbackUrl,
    });

    payment.checkoutRequestId = response?.CheckoutRequestID;
    payment.merchantRequestId = response?.MerchantRequestID;
    payment.mpesaResponse = response;

    if (String(response?.ResponseCode) === '0' && this.mpesa.sandboxMode) {
      payment.status = 'PAID';
      payment.mpesaReceiptNumber = `SANDBOX-${Math.random().toString(36).slice(2, 10)}`;
      payment.mpesaResultDesc = 'Sandbox: paid';
      payment.updatedAt = new Date().toISOString();
      await this.sendPaymentNotifications(payment);
      if (payment.type === 'SUBSCRIPTION') {
        InMemoryStore.create('subscriptions', {
          userId: payment.userId,
          role: payment.payerRole,
          plan: payment.plan || 'monthly',
          amount: payment.amount,
          currency: payment.currency,
          status: 'ACTIVE',
          startedAt: new Date().toISOString(),
        });
        await mergeProfileExtras(this.prisma, payment.userId, {
          subscriptionActive: true,
          premiumActive: true,
        });
      }
      if (payment.type === 'ORDER' && payment.orderId) {
        const updatedOrder = InMemoryStore.update('orders', payment.orderId, {
          status: 'PAID',
          paymentId: payment.id,
          updatedAt: new Date().toISOString(),
        });
        this.emitCheckoutCompleteEvent(updatedOrder, payment);
      }
    }

    return {
      payment,
      mpesa: response,
    };
  }

  @Get('history')
  async history(
    @Req() req: any,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const role = req.user?.role;
    const userId = req.user?.userId;
    const payments = InMemoryStore.list('payments');
    let list =
      role === 'SUPER_ADMIN'
        ? payments
        : payments.filter((item) => item.userId === userId || item.recipientId === userId);

    if (type) {
      list = list.filter((item) => String(item.type || '').toUpperCase() === String(type).toUpperCase());
    }
    if (status) {
      list = list.filter(
        (item) => String(item.status || '').toUpperCase() === String(status).toUpperCase(),
      );
    }
    if (start || end) {
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;
      list = list.filter((item) => {
        const created = new Date(item.createdAt);
        if (startDate && created < startDate) return false;
        if (endDate && created > endDate) return false;
        return true;
      });
    }
    return list;
  }

  @Get('wallet')
  async wallet(@Req() req: any, @Query('ownerId') ownerId?: string) {
    const scopedOwnerId = await this.resolveWalletOwnerId(req, ownerId);
    return this.buildWalletSnapshot(scopedOwnerId);
  }

  @Post('wallet/withdrawal')
  async requestWithdrawal(@Req() req: any, @Body() body: any) {
    const scopedOwnerId = await this.resolveWalletOwnerId(req, body?.ownerId);
    const amount = this.normalizeMoney(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }

    const snapshot = this.buildWalletSnapshot(scopedOwnerId);
    if (amount > this.normalizeMoney(snapshot?.summary?.availableBalance)) {
      throw new BadRequestException('Insufficient wallet balance for this withdrawal request.');
    }

    const role = String(req?.user?.role || '').trim().toUpperCase();
    const request = InMemoryStore.create('withdrawals', {
      ownerId: scopedOwnerId,
      requestedBy: req?.user?.userId || null,
      requesterRole: role,
      amount,
      currency: 'KES',
      destination: body?.destination || body?.phone || null,
      note: body?.note || '',
      status: 'REQUESTED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const superAdmins = await this.prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true },
      take: 50,
    });
    superAdmins.forEach((admin) => {
      InMemoryStore.create('notifications', {
        userId: admin.id,
        title: 'New Withdrawal Request',
        message: `${role} requested KES ${amount.toLocaleString()} withdrawal.`,
        type: 'INFO',
        relatedId: request.id,
        isRead: false,
        createdAt: new Date().toISOString(),
      } as any);
    });

    InMemoryStore.logAudit({
      action: 'WALLET_WITHDRAWAL_REQUESTED',
      targetId: request.id,
      by: req?.user?.userId || null,
      ownerId: scopedOwnerId,
      amount,
      createdAt: new Date().toISOString(),
    });

    return {
      success: true,
      request,
      summary: this.buildWalletSnapshot(scopedOwnerId).summary,
    };
  }

  @Get('methods')
  async methods() {
    return [
      { id: 'intasend', name: 'IntaSend' },
    ];
  }

  @Get('rates')
  async rates() {
    return {
      USD_KES: this.getUsdKesRate(),
    };
  }

  @Post('mpesa/query')
  async queryMpesa(@Req() req: any, @Body() body: any) {
    const checkoutRequestId = body.checkoutRequestId || body.checkout_request_id;
    if (!checkoutRequestId) {
      throw new BadRequestException('checkoutRequestId is required');
    }
    const response = await this.mpesa.stkQuery(checkoutRequestId);
    const payments = InMemoryStore.list('payments');
    const payment = payments.find((p) => p.checkoutRequestId === checkoutRequestId);
    if (
      payment &&
      req.user?.role !== 'SUPER_ADMIN' &&
      payment.userId !== req.user?.userId
    ) {
      throw new ForbiddenException('You cannot query this payment');
    }
    if (payment && String(response?.ResultCode) === '0') {
      payment.status = 'PAID';
      payment.mpesaResultDesc = response?.ResultDesc || payment.mpesaResultDesc;
      payment.updatedAt = new Date().toISOString();
      await this.sendPaymentNotifications(payment);
      if (payment.type === 'SUBSCRIPTION') {
        InMemoryStore.create('subscriptions', {
          userId: payment.userId,
          role: payment.payerRole,
          plan: payment.plan || 'monthly',
          amount: payment.amount,
          currency: payment.currency,
          status: 'ACTIVE',
          startedAt: new Date().toISOString(),
        });
        await mergeProfileExtras(this.prisma, payment.userId, {
          subscriptionActive: true,
          premiumActive: true,
        });
      }
      if (payment.type === 'ORDER' && payment.orderId) {
        const updatedOrder = InMemoryStore.update('orders', payment.orderId, {
          status: 'PAID',
          paymentId: payment.id,
          updatedAt: new Date().toISOString(),
        });
        this.emitCheckoutCompleteEvent(updatedOrder, payment);
      }
    }
    return { mpesa: response, payment };
  }

  @Post('mpesa/reconcile')
  async reconcileMpesa(@Req() req: any) {
    if (req.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only admin can run reconciliation');
    }
    const payments = InMemoryStore.list('payments').filter(
      (p) => p.method === 'mpesa' && p.status === 'PENDING' && p.checkoutRequestId,
    );
    const results: Array<{ id: string; response?: unknown; error?: string }> = [];
    for (const payment of payments) {
      try {
        const response = await this.mpesa.stkQuery(payment.checkoutRequestId);
        if (String(response?.ResultCode) === '0') {
          payment.status = 'PAID';
          payment.mpesaResultDesc = response?.ResultDesc || payment.mpesaResultDesc;
          payment.updatedAt = new Date().toISOString();
          await this.sendPaymentNotifications(payment);
          if (payment.type === 'SUBSCRIPTION') {
            InMemoryStore.create('subscriptions', {
              userId: payment.userId,
              role: payment.payerRole,
              plan: payment.plan || 'monthly',
              amount: payment.amount,
              currency: payment.currency,
              status: 'ACTIVE',
              startedAt: new Date().toISOString(),
            });
            await mergeProfileExtras(this.prisma, payment.userId, {
              subscriptionActive: true,
              premiumActive: true,
            });
          }
          if (payment.type === 'ORDER' && payment.orderId) {
            const updatedOrder = InMemoryStore.update('orders', payment.orderId, {
              status: 'PAID',
              paymentId: payment.id,
              updatedAt: new Date().toISOString(),
            });
            this.emitCheckoutCompleteEvent(updatedOrder, payment);
          }
        }
        results.push({ id: payment.id, response });
      } catch (error) {
        results.push({ id: payment.id, error: error.message || 'Query failed' });
      }
    }
    return { count: results.length, results };
  }
}
