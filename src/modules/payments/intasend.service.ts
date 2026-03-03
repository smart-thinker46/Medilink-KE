import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { InMemoryStore } from 'src/common/in-memory.store';
import { mergeProfileExtras } from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';
import { EmailsService } from '../emails/emails.service';

@Injectable()
export class IntaSendService {
  private readonly logger = new Logger(IntaSendService.name);

  constructor(
    private config: ConfigService,
    private emails: EmailsService,
    private prisma: PrismaService,
  ) {}

  private get keyMode(): 'live' | 'test' | 'unknown' {
    const key = this.publishableKey;
    if (/_live_/i.test(key)) return 'live';
    if (/_test_/i.test(key)) return 'test';
    return 'unknown';
  }

  private get baseUrl() {
    const configured = String(this.config.get('INTASEND_BASE_URL') || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    // Auto-match environment when INTASEND_BASE_URL is not set.
    return this.keyMode === 'live'
      ? 'https://payment.intasend.com'
      : 'https://sandbox.intasend.com';
  }

  private get checkoutEndpoint() {
    const raw = String(this.config.get('INTASEND_CHECKOUT_ENDPOINT') || '/api/v1/checkout/');
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private get publishableKey() {
    return String(this.config.get('INTASEND_PUBLISHABLE_KEY') || '').trim();
  }

  private get secretKey() {
    return String(this.config.get('INTASEND_SECRET_KEY') || '').trim();
  }

  private get redirectUrl() {
    return String(this.config.get('INTASEND_REDIRECT_URL') || '').trim();
  }

  private get callbackUrl() {
    return String(this.config.get('INTASEND_CALLBACK_URL') || '').trim();
  }

  private get checkoutHeaders() {
    return {
      'X-IntaSend-Public-API-Key': this.publishableKey,
    };
  }

  private isSandboxBaseUrl(url: string) {
    return /sandbox\.intasend\.com/i.test(url);
  }

  private isLiveBaseUrl(url: string) {
    return /payment\.intasend\.com/i.test(url);
  }

  private isEnvironmentMismatch() {
    const mode = this.keyMode;
    const base = this.baseUrl;
    if (mode === 'live' && this.isSandboxBaseUrl(base)) return true;
    if (mode === 'test' && this.isLiveBaseUrl(base)) return true;
    return false;
  }

  private extractErrorMessage(error: any) {
    const data = error?.response?.data;
    if (typeof data === 'string' && data.trim()) return data;
    return (
      data?.message ||
      data?.detail ||
      data?.error ||
      data?.errors?.[0]?.detail ||
      data?.errors?.[0]?.message ||
      error?.message ||
      'Failed to initialize IntaSend payment.'
    );
  }

  private shouldRetryCheckout(error: any) {
    const status = Number(error?.response?.status || 0);
    if (!status) return true;
    if (status >= 500) return true;
    if (status === 401 || status === 403 || status === 429) return true;
    return false;
  }

  private normalizePhone(phone?: string | null) {
    const raw = String(phone || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/[^\d]/g, '');
    if (!digits) return '';
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
    if (digits.length >= 10 && digits.length <= 15) return digits;
    return '';
  }

  async createCheckout(payload: {
    amount: number;
    currency: string;
    email?: string | null;
    phone?: string | null;
    apiRef: string;
    description?: string;
  }) {
    if (!this.publishableKey) {
      throw new BadRequestException(
        'IntaSend is not configured. Set INTASEND_PUBLISHABLE_KEY.',
      );
    }

    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }

    const requestBody: Record<string, any> = {
      public_key: this.publishableKey,
      amount,
      currency: String(payload.currency || 'KES').toUpperCase(),
      api_ref: payload.apiRef,
      comment: payload.description || 'Payment',
    };

    if (payload.email) requestBody.email = payload.email;
    const normalizedPhone = this.normalizePhone(payload.phone);
    if (normalizedPhone) requestBody.phone_number = normalizedPhone;
    if (this.redirectUrl) requestBody.redirect_url = this.redirectUrl;
    if (this.callbackUrl) requestBody.callback_url = this.callbackUrl;

    const attempts: Array<{
      label: string;
      body: Record<string, any>;
      headers: Record<string, string>;
    }> = [
      {
        label: 'public-header',
        body: requestBody,
        headers: this.checkoutHeaders,
      },
      {
        label: 'public-body-only',
        body: requestBody,
        headers: {},
      },
    ];

    let lastError: any = null;
    let publicAttemptError: any = null;
    for (const attempt of attempts) {
      try {
        const response = await axios.post(
          `${this.baseUrl}${this.checkoutEndpoint}`,
          attempt.body,
          {
            headers: {
              'Content-Type': 'application/json',
              ...attempt.headers,
            },
            timeout: 20000,
          },
        );

        const data = response?.data || {};
        const checkoutUrl =
          data?.url ||
          data?.checkout_url ||
          data?.invoice?.url ||
          data?.invoice_url ||
          data?.data?.url ||
          null;
        const gatewayReference =
          data?.invoice?.invoice_id ||
          data?.invoice_id ||
          data?.checkout_id ||
          data?.id ||
          null;

        return {
          checkoutUrl,
          gatewayReference,
          raw: data,
        };
      } catch (error: any) {
        lastError = error;
        publicAttemptError = error;
        const status = error?.response?.status;
        const message = this.extractErrorMessage(error);
        this.logger.warn(
          `IntaSend checkout attempt "${attempt.label}" failed (${status || 'unknown'}): ${message}`,
        );
        if (!this.shouldRetryCheckout(error)) break;
      }
    }

    const effectiveError = publicAttemptError || lastError;
    const status = effectiveError?.response?.status;
    const mismatch = this.isEnvironmentMismatch();
    const message = this.extractErrorMessage(effectiveError);
    let finalMessage =
      status === 401 && mismatch
        ? `IntaSend key environment mismatch: ${this.keyMode.toUpperCase()} keys cannot be used with ${this.baseUrl}.`
        : message;
    if (status >= 500) {
      finalMessage =
        'IntaSend is currently rejecting checkout requests (HTTP 5xx). Verify IntaSend account activation and API keys, or switch to test keys + sandbox for development.';
    }
    this.logger.warn(`IntaSend checkout failed (${status || 'unknown'}): ${finalMessage}`);
    throw new BadRequestException(finalMessage);
  }

  private isPaidStatus(status: unknown) {
    const value = String(status || '').toUpperCase();
    return (
      value === 'PAID' ||
      value === 'SUCCESS' ||
      value === 'COMPLETE' ||
      value === 'COMPLETED'
    );
  }

  private isFailedStatus(status: unknown) {
    const value = String(status || '').toUpperCase();
    return value === 'FAILED' || value === 'CANCELLED' || value === 'DECLINED';
  }

  private extractStatus(payload: any) {
    return (
      payload?.state ||
      payload?.status ||
      payload?.invoice?.state ||
      payload?.invoice?.status ||
      payload?.data?.state ||
      payload?.data?.status ||
      ''
    );
  }

  private extractReference(payload: any) {
    return (
      payload?.api_ref ||
      payload?.invoice?.api_ref ||
      payload?.data?.api_ref ||
      payload?.metadata?.api_ref ||
      payload?.reference ||
      ''
    );
  }

  private async markPaymentPaid(payment: any) {
    if (!payment || String(payment.status || '').toUpperCase() === 'PAID') return payment;

    payment.status = 'PAID';
    payment.updatedAt = new Date().toISOString();
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
    if (recipientId) {
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
      if (updatedOrder) {
        InMemoryStore.create('pharmacyEvents', {
          pharmacyId: updatedOrder?.pharmacyId || payment?.recipientId || null,
          type: 'CHECKOUT_COMPLETE',
          userId: updatedOrder?.buyerId || updatedOrder?.patientId || payment?.userId || null,
          orderId: updatedOrder?.id || payment?.orderId || null,
          metadata: {
            status: 'PAID',
            total: updatedOrder?.total ?? payment?.amount ?? 0,
            currency: updatedOrder?.currency || payment?.currency || 'KES',
            paymentId: payment?.id || null,
          },
          createdAt: new Date().toISOString(),
        });
      }
    }

    return payment;
  }

  async handleWebhook(body: any, headers?: Record<string, any>) {
    const status = this.extractStatus(body);
    const apiRef = this.extractReference(body);
    const requestId = headers?.['x-request-id'] || headers?.['X-Request-Id'] || null;

    if (!apiRef) {
      this.logger.warn('IntaSend webhook received without api_ref.');
      return { success: false, reason: 'missing_api_ref', requestId };
    }

    const payment =
      InMemoryStore.findById('payments', apiRef) ||
      (InMemoryStore.list('payments') as any[]).find(
        (item) => item?.apiRef === apiRef || item?.receiptNumber === apiRef,
      );

    if (!payment) {
      this.logger.warn(`IntaSend webhook payment not found for api_ref=${apiRef}`);
      return { success: false, reason: 'payment_not_found', apiRef, requestId };
    }

    payment.gateway = 'INTASEND';
    payment.gatewayWebhook = body;
    payment.gatewayStatus = status;
    payment.updatedAt = new Date().toISOString();

    if (this.isPaidStatus(status)) {
      await this.markPaymentPaid(payment);
      return { success: true, paymentId: payment.id, status: payment.status };
    }
    if (this.isFailedStatus(status)) {
      payment.status = 'FAILED';
      payment.updatedAt = new Date().toISOString();
      return { success: true, paymentId: payment.id, status: payment.status };
    }

    return {
      success: true,
      paymentId: payment.id,
      status: payment.status,
      gatewayStatus: status || 'PENDING',
    };
  }
}
