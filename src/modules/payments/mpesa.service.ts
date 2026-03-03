import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { mergeProfileExtras } from 'src/common/profile-extras';
import { EmailsService } from '../emails/emails.service';

@Injectable()
export class MpesaService {
  constructor(
    private config: ConfigService,
    private emails: EmailsService,
    private prisma: PrismaService,
  ) {}

  private get baseUrl() {
    return this.config.get('MPESA_BASE_URL') || 'https://sandbox.safaricom.co.ke';
  }

  private get isSandboxMode() {
    return String(this.config.get('MPESA_SANDBOX_MODE') || 'false') === 'true';
  }

  get sandboxMode() {
    return this.isSandboxMode;
  }

  private normalizePhone(phone?: string) {
    if (!phone) return '';
    const trimmed = String(phone).trim();
    let digits = trimmed.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('00')) digits = digits.slice(2);
    // Handle malformed inputs like 25407xxxxxxxx -> 2547xxxxxxxx
    if (digits.startsWith('2540') && digits.length === 13) {
      digits = `254${digits.slice(4)}`;
    }
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if ((digits.startsWith('07') || digits.startsWith('01')) && digits.length === 10) {
      return `254${digits.slice(1)}`;
    }
    if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) {
      return `254${digits}`;
    }
    return digits;
  }

  private normalizeCallbackUrl(url?: string) {
    if (!url) return '';
    let value = String(url).trim();
    if (!value) return '';
    // Common typo seen in env/request payloads.
    value = value.replace(/^hhttps:\/\//i, 'https://');
    value = value.replace(/^http:\/\//i, 'https://');
    return value;
  }

  private validateCallbackUrl(rawUrl?: string) {
    const callbackUrl = this.normalizeCallbackUrl(rawUrl);
    if (!callbackUrl) {
      throw new BadRequestException('M-Pesa callback URL is missing.');
    }
    try {
      const parsed = new URL(callbackUrl);
      if (parsed.protocol !== 'https:') {
        throw new Error('Callback URL must use HTTPS.');
      }
      if (!parsed.hostname) {
        throw new Error('Callback URL host is missing.');
      }
      return callbackUrl;
    } catch {
      throw new BadRequestException(
        'Invalid M-Pesa callback URL. Use a valid HTTPS URL, e.g. https://your-domain.com/api/mpesa/callback',
      );
    }
  }

  private readAxiosMessage(error: unknown, fallback: string) {
    if (!axios.isAxiosError(error)) return fallback;
    const data = error.response?.data as
      | { errorMessage?: string; ResponseDescription?: string; message?: string }
      | undefined;
    return (
      data?.errorMessage ||
      data?.ResponseDescription ||
      data?.message ||
      error.message ||
      fallback
    );
  }

  private async getAccessToken() {
    const consumerKey = this.config.get('MPESA_CONSUMER_KEY');
    const consumerSecret = this.config.get('MPESA_CONSUMER_SECRET');
    if (!consumerKey || !consumerSecret) {
      throw new Error('M-Pesa credentials missing');
    }
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    try {
      const { data } = await axios.get(
        `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: { Authorization: `Basic ${auth}` },
        },
      );
      return data?.access_token;
    } catch (error) {
      throw new BadRequestException(
        this.readAxiosMessage(
          error,
          'Failed to authenticate with M-Pesa. Check MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET.',
        ),
      );
    }
  }

  private generatePassword(shortCode: string, passkey: string, timestamp: string) {
    return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
  }

  async stkQuery(checkoutRequestId: string) {
    const shortCode = this.config.get('MPESA_SHORTCODE');
    const passkey = this.config.get('MPESA_PASSKEY');
    if (!shortCode || !passkey) {
      throw new Error('M-Pesa configuration missing');
    }
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = this.generatePassword(shortCode, passkey, timestamp);

    if (this.isSandboxMode) {
      return {
        ResponseCode: '0',
        ResponseDescription: 'Sandbox mode: simulated query',
        CheckoutRequestID: checkoutRequestId,
        ResultCode: '0',
        ResultDesc: 'Sandbox: paid',
      };
    }

    const token = await this.getAccessToken();
    const { data } = await axios.post(
      `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return data;
  }

  async stkPush(payload: {
    amount: number;
    phone: string;
    accountReference: string;
    description: string;
    callbackUrl: string;
  }) {
    const phone = this.normalizePhone(payload.phone);
    if (!/^254\d{9}$/.test(phone)) {
      throw new BadRequestException(
        'Invalid phone number. Use 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX or 2547XXXXXXXX.',
      );
    }
    const shortCode = this.config.get('MPESA_SHORTCODE');
    const passkey = this.config.get('MPESA_PASSKEY');
    const callbackUrl = this.validateCallbackUrl(
      payload.callbackUrl || this.config.get('MPESA_CALLBACK_URL'),
    );
    if (!shortCode || !passkey || !callbackUrl) {
      throw new Error('M-Pesa configuration missing');
    }
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = this.generatePassword(shortCode, passkey, timestamp);

    if (this.isSandboxMode) {
      return {
        MerchantRequestID: `SANDBOX-${Date.now()}`,
        CheckoutRequestID: `SANDBOX-${Math.random().toString(36).slice(2, 10)}`,
        ResponseCode: '0',
        ResponseDescription: 'Sandbox mode: simulated success',
        CustomerMessage: 'Sandbox: STK push simulated',
      };
    }

    const token = await this.getAccessToken();
    try {
      const { data } = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: shortCode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: Math.round(Number(payload.amount)),
          PartyA: phone,
          PartyB: shortCode,
          PhoneNumber: phone,
          CallBackURL: callbackUrl,
          AccountReference: payload.accountReference,
          TransactionDesc: payload.description,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      return data;
    } catch (error) {
      throw new BadRequestException(
        this.readAxiosMessage(error, 'Failed to initiate M-Pesa STK push.'),
      );
    }
  }

  async handleCallback(body: any) {
    const callback = body?.Body?.stkCallback;
    if (!callback) return { success: false };
    const {
      ResultCode,
      ResultDesc,
      CheckoutRequestID,
      MerchantRequestID,
      CallbackMetadata,
    } = callback;
    const metadataItems = CallbackMetadata?.Item || [];
    const getItem = (name: string) =>
      metadataItems.find((item) => item.Name === name)?.Value;

    const amount = getItem('Amount');
    const receipt = getItem('MpesaReceiptNumber');
    const phone = getItem('PhoneNumber');
    const transactionDate = getItem('TransactionDate');

    const payments = InMemoryStore.list('payments');
    const payment = payments.find(
      (p) => p.checkoutRequestId === CheckoutRequestID || p.merchantRequestId === MerchantRequestID,
    );
    if (payment) {
      payment.status = String(ResultCode) === '0' ? 'PAID' : 'FAILED';
      payment.mpesaReceiptNumber = receipt || payment.mpesaReceiptNumber;
      payment.mpesaResultDesc = ResultDesc;
      payment.mpesaTransactionDate = transactionDate;
      payment.mpesaPhone = phone;
      payment.updatedAt = new Date().toISOString();
      if (payment.status === 'PAID') {
        await this.emails.sendPaymentReceipt(payment).catch(() => undefined);
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
          InMemoryStore.update('orders', payment.orderId, {
            status: 'PAID',
            paymentId: payment.id,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    return { success: true };
  }
}
