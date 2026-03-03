import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

@Injectable()
export class EmailsService {
  constructor(private config: ConfigService) {}

  private get brand() {
    return {
      background: '#ffffff',
      text: '#000000',
      link: '#ff7a00',
      button: '#055d8c',
      logo: LOGO_DATA_URI,
      name: 'MediLink Kenya',
      address: this.config.get<string>('COMPANY_ADDRESS') || 'Nairobi, Kenya',
      phone: this.config.get<string>('COMPANY_PHONE') || '+254 700 000 000',
      supportEmail:
        this.config.get<string>('SUPPORT_EMAIL') || this.config.get<string>('RESEND_FROM') || 'info@medilinkkenya.com',
      socials: {
        twitter: this.config.get<string>('SOCIAL_TWITTER') || '',
        facebook: this.config.get<string>('SOCIAL_FACEBOOK') || '',
        instagram: this.config.get<string>('SOCIAL_INSTAGRAM') || '',
        linkedin: this.config.get<string>('SOCIAL_LINKEDIN') || '',
      },
    };
  }

  private get apiKey() {
    return this.config.get<string>('RESEND_API_KEY');
  }

  private get fromEmail() {
    return this.config.get<string>('RESEND_FROM') || 'info@medilinkkenya.com';
  }

  buildBrandedHtml(options: {
    title: string;
    body: string;
    ctaLabel?: string;
    ctaUrl?: string;
    locale?: 'en' | 'sw';
  }) {
    const { title, body, ctaLabel, ctaUrl, locale = 'en' } = options;
    const { background, text, link, button, logo, name, address, phone, supportEmail, socials } =
      this.brand;
    const ctaButton = ctaLabel && ctaUrl
      ? `<a href="${ctaUrl}" style="display:inline-block;background:${button};color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;">${ctaLabel}</a>`
      : '';
    const footerTitle = this.t(locale, 'footer_title');
    const supportLabel = this.t(locale, 'support');
    const socialsLabel = this.t(locale, 'socials');
    const socialsLinks = Object.entries(socials)
      .filter(([, url]) => url)
      .map(([key, url]) => `<a href="${url}" style="color:${link};text-decoration:none;margin-right:10px;">${key}</a>`)
      .join('');
    return `
      <div style="background:${background};color:${text};font-family:Arial, sans-serif;max-width:640px;margin:0 auto;padding:24px;">
        ${logo ? `<img src="${logo}" alt="${name}" style="height:48px;margin-bottom:16px;" />` : ''}
        <h2 style="margin:0 0 12px;color:${text};">${title}</h2>
        <div style="font-size:14px;line-height:1.6;color:${text};">
          ${body}
        </div>
        ${ctaButton ? `<div style="margin-top:16px;">${ctaButton}</div>` : ''}
        <div style="margin-top:24px;border-top:1px solid #eee;padding-top:16px;font-size:12px;color:${text};">
          <div style="font-weight:600;margin-bottom:6px;">${footerTitle}</div>
          <div>${address}</div>
          <div>${phone}</div>
          <div>${supportLabel}: <a href="mailto:${supportEmail}" style="color:${link};text-decoration:none;">${supportEmail}</a></div>
          ${
            socialsLinks
              ? `<div style="margin-top:8px;">${socialsLabel}: ${socialsLinks}</div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  async sendTransactional(payload: {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    tags?: Record<string, string>;
    metadata?: Record<string, any>;
    attachments?: { filename: string; content: string; contentType?: string }[];
  }) {
    if (!this.apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    const unsubscribeEmail =
      this.config.get<string>('UNSUBSCRIBE_EMAIL') ||
      this.config.get<string>('SUPPORT_EMAIL') ||
      this.fromEmail;
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: this.fromEmail,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        tags: payload.tags ? Object.entries(payload.tags).map(([name, value]) => ({ name, value })) : undefined,
        attachments: payload.attachments,
        headers: {
          'X-Entity-Ref-ID': payload.metadata?.refId,
          'List-Unsubscribe': `<mailto:${unsubscribeEmail}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return response.data;
  }

  async sendPaymentReceipt(payment: any) {
    const to = payment?.payerEmail;
    if (!to) return null;

    const amount = payment?.amount || 0;
    const currency = payment?.currency || 'KES';
    const chargedAmount = payment?.chargedAmount;
    const chargedCurrency = payment?.chargedCurrency;
    const invoiceNumber = payment?.invoiceNumber || payment?.receiptNumber || payment?.id;
    const description = payment?.description || 'Payment';

    const locale = (payment?.locale || 'en') as 'en' | 'sw';
    const html = this.buildBrandedHtml({
      title: this.t(locale, 'receipt_title'),
      body: `
        <p><strong>${this.t(locale, 'invoice')}:</strong> ${invoiceNumber}</p>
        <p><strong>${this.t(locale, 'description')}:</strong> ${description}</p>
        <p><strong>${this.t(locale, 'amount')}:</strong> ${currency} ${amount}</p>
        ${
          chargedAmount && chargedCurrency
            ? `<p><strong>${this.t(locale, 'charged')}:</strong> ${chargedCurrency} ${chargedAmount}</p>`
            : ''
        }
        <p><strong>${this.t(locale, 'status')}:</strong> ${payment?.status || 'PENDING'}</p>
        <p><strong>${this.t(locale, 'date')}:</strong> ${payment?.createdAt || new Date().toISOString()}</p>
      `,
      locale,
    });
    const attachment = await this.generateReceiptPdfFromHtml(html, invoiceNumber);

    return this.sendTransactional({
      to,
      subject: this.t(locale, 'receipt_subject'),
      html,
      text: `${this.t(locale, 'receipt_subject')} ${invoiceNumber}: ${currency} ${amount} - ${description}`,
      metadata: { refId: invoiceNumber },
      tags: { type: 'receipt' },
      attachments: attachment ? [attachment] : undefined,
    });
  }

  async sendAccountStatusNotification(payload: {
    to: string;
    blocked: boolean;
    userName?: string;
    locale?: 'en' | 'sw';
  }) {
    if (!payload?.to) return null;
    const locale = payload.locale || 'en';
    const titleKey = payload.blocked ? 'account_blocked_title' : 'account_unblocked_title';
    const bodyKey = payload.blocked ? 'account_blocked_body' : 'account_unblocked_body';
    const userName = payload.userName || 'User';
    return this.sendTransactional({
      to: payload.to,
      subject: this.t(locale, titleKey),
      html: this.buildBrandedHtml({
        title: this.t(locale, titleKey),
        body: `<p>${this.t(locale, bodyKey)}</p><p><strong>${userName}</strong></p>`,
        locale,
      }),
      text: `${this.t(locale, titleKey)}: ${this.t(locale, bodyKey)}`,
      tags: { type: payload.blocked ? 'account-blocked' : 'account-unblocked' },
    });
  }

  async sendSubscriptionReminder(payload: {
    to: string;
    daysLeft?: number;
    locale?: 'en' | 'sw';
  }) {
    if (!payload?.to) return null;
    const locale = payload.locale || 'en';
    const daysLeft = Number(payload?.daysLeft || 0);
    const extra = Number.isFinite(daysLeft) && daysLeft > 0 ? ` (${daysLeft} day(s) left)` : '';
    return this.sendTransactional({
      to: payload.to,
      subject: this.t(locale, 'subscription_reminder_title'),
      html: this.buildBrandedHtml({
        title: this.t(locale, 'subscription_reminder_title'),
        body: `<p>${this.t(locale, 'subscription_reminder_body')}${extra}</p>`,
        locale,
      }),
      text: `${this.t(locale, 'subscription_reminder_body')}${extra}`,
      tags: { type: 'subscription-reminder' },
    });
  }

  async sendSubscriptionSuccess(payload: {
    to: string;
    plan?: string;
    amount?: number;
    currency?: string;
    locale?: 'en' | 'sw';
  }) {
    if (!payload?.to) return null;
    const locale = payload.locale || 'en';
    const plan = payload.plan || 'monthly';
    const amount = Number(payload.amount || 0);
    const currency = payload.currency || 'KES';
    return this.sendTransactional({
      to: payload.to,
      subject: this.t(locale, 'subscription_success_title'),
      html: this.buildBrandedHtml({
        title: this.t(locale, 'subscription_success_title'),
        body: `<p>${this.t(locale, 'subscription_success_body')}</p><p><strong>Plan:</strong> ${plan}</p><p><strong>Amount:</strong> ${currency} ${amount}</p>`,
        locale,
      }),
      text: `${this.t(locale, 'subscription_success_body')} Plan: ${plan}. Amount: ${currency} ${amount}.`,
      tags: { type: 'subscription-success' },
    });
  }

  async sendOrderReceived(payload: {
    to: string;
    orderId?: string;
    total?: number;
    currency?: string;
    locale?: 'en' | 'sw';
  }) {
    if (!payload?.to) return null;
    const locale = payload.locale || 'en';
    const total = Number(payload.total || 0);
    const currency = payload.currency || 'KES';
    const orderId = payload.orderId || '-';
    return this.sendTransactional({
      to: payload.to,
      subject: this.t(locale, 'order_received_title'),
      html: this.buildBrandedHtml({
        title: this.t(locale, 'order_received_title'),
        body: `<p>${this.t(locale, 'order_received_body')}</p><p><strong>Order:</strong> ${orderId}</p><p><strong>Total:</strong> ${currency} ${total}</p>`,
        locale,
      }),
      text: `${this.t(locale, 'order_received_body')} Order: ${orderId}. Total: ${currency} ${total}.`,
      tags: { type: 'order-received' },
    });
  }

  async sendPaymentReceived(payload: {
    to: string;
    amount?: number;
    currency?: string;
    description?: string;
    locale?: 'en' | 'sw';
  }) {
    if (!payload?.to) return null;
    const locale = payload.locale || 'en';
    const amount = Number(payload.amount || 0);
    const currency = payload.currency || 'KES';
    const description = payload.description || this.t(locale, 'payment_received_title');
    return this.sendTransactional({
      to: payload.to,
      subject: this.t(locale, 'payment_received_title'),
      html: this.buildBrandedHtml({
        title: this.t(locale, 'payment_received_title'),
        body: `<p>${this.t(locale, 'payment_received_body')}</p><p><strong>${this.t(locale, 'description')}:</strong> ${description}</p><p><strong>${this.t(locale, 'amount')}:</strong> ${currency} ${amount}</p>`,
        locale,
      }),
      text: `${this.t(locale, 'payment_received_body')} ${description}. ${currency} ${amount}.`,
      tags: { type: 'payment-received' },
    });
  }

  private async generateReceiptPdfFromHtml(html: string, invoiceNumber: string) {
    try {
      // Lazy-load to avoid hard dependency if not installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();
      return {
        filename: `receipt-${invoiceNumber || 'payment'}.pdf`,
        content: pdfBuffer.toString('base64'),
        contentType: 'application/pdf',
      };
    } catch (error) {
      return null;
    }
  }

  t(locale: 'en' | 'sw', key: string) {
    const dict = {
      en: {
        welcome_title: 'Welcome to MediLink Kenya',
        welcome_body: 'Your account has been created successfully.',
        welcome_security: 'If you didn’t create this account, please contact support.',
        password_reset_title: 'Reset your password',
        password_reset_body: 'Click the button below to reset your password. This link expires in 30 minutes.',
        reset_button: 'Reset Password',
        password_changed_title: 'Password Updated',
        password_changed_body: 'Your password was successfully updated. If this wasn’t you, please contact support immediately.',
        appointment_confirmed_title: 'Appointment Confirmation',
        appointment_confirmed_body: 'Your appointment is confirmed.',
        appointment_update_title: 'Appointment Update',
        appointment_update_body: 'Your appointment was updated.',
        order_confirmed_title: 'Order Confirmation',
        order_confirmed_body: 'Your order has been placed successfully.',
        order_update_title: 'Order Status Update',
        order_update_body: 'Your order was updated.',
        new_order_title: 'New Order Received',
        new_order_body: 'You have a new order.',
        order_received_title: 'Order Received',
        order_received_body: 'A new order has been received in your account.',
        account_blocked_title: 'Account Blocked',
        account_blocked_body: 'Your account has been blocked by an administrator. Please contact support.',
        account_unblocked_title: 'Account Unblocked',
        account_unblocked_body: 'Your account has been unblocked. You can continue using the app.',
        subscription_reminder_title: 'Subscription Reminder',
        subscription_reminder_body: 'Your subscription is almost due. Please renew to avoid service interruption.',
        subscription_success_title: 'Subscription Activated Successfully',
        subscription_success_body: 'Your subscription payment was successful and premium access is now active.',
        payment_received_title: 'Payment Received',
        payment_received_body: 'A payment has been received in your account.',
        receipt_subject: 'MediLink Kenya Payment Receipt',
        receipt_title: 'Payment Receipt',
        invoice: 'Invoice',
        description: 'Description',
        amount: 'Amount',
        charged: 'Charged',
        status: 'Status',
        date: 'Date',
        footer_title: 'Contact',
        support: 'Support',
        socials: 'Socials',
      },
      sw: {
        welcome_title: 'Karibu MediLink Kenya',
        welcome_body: 'Akaunti yako imeundwa kwa mafanikio.',
        welcome_security: 'Iwapo hukuunda akaunti hii, tafadhali wasiliana na msaada.',
        password_reset_title: 'Weka upya nenosiri',
        password_reset_body: 'Bofya kitufe hapa chini ili kuweka upya nenosiri lako. Kiungo hiki kitaisha ndani ya dakika 30.',
        reset_button: 'Weka upya nenosiri',
        password_changed_title: 'Nenosiri Limebadilishwa',
        password_changed_body: 'Nenosiri lako limebadilishwa kwa mafanikio. Ikiwa hukuifanya, tafadhali wasiliana na msaada mara moja.',
        appointment_confirmed_title: 'Uthibitisho wa Miadi',
        appointment_confirmed_body: 'Miadi yako imethibitishwa.',
        appointment_update_title: 'Sasisho la Miadi',
        appointment_update_body: 'Miadi yako imesasishwa.',
        order_confirmed_title: 'Uthibitisho wa Oda',
        order_confirmed_body: 'Oda yako imewekwa kwa mafanikio.',
        order_update_title: 'Sasisho la Oda',
        order_update_body: 'Oda yako imesasishwa.',
        new_order_title: 'Oda Mpya Imepokelewa',
        new_order_body: 'Una oda mpya.',
        order_received_title: 'Oda Imepokelewa',
        order_received_body: 'Oda mpya imepokelewa kwenye akaunti yako.',
        account_blocked_title: 'Akaunti Imefungwa',
        account_blocked_body: 'Akaunti yako imefungwa na msimamizi. Tafadhali wasiliana na msaada.',
        account_unblocked_title: 'Akaunti Imefunguliwa',
        account_unblocked_body: 'Akaunti yako imefunguliwa. Unaweza kuendelea kutumia programu.',
        subscription_reminder_title: 'Kikumbusho cha Usajili',
        subscription_reminder_body: 'Usajili wako unakaribia kuisha. Tafadhali lipia upya ili huduma zisiingiliwe.',
        subscription_success_title: 'Usajili Umeamilishwa Kikamilifu',
        subscription_success_body: 'Malipo ya usajili yamefanikiwa na ufikiaji wa premium umewezeshwa.',
        payment_received_title: 'Malipo Yamepokelewa',
        payment_received_body: 'Malipo mapya yamepokelewa kwenye akaunti yako.',
        receipt_subject: 'Risiti ya Malipo MediLink Kenya',
        receipt_title: 'Risiti ya Malipo',
        invoice: 'Ankara',
        description: 'Maelezo',
        amount: 'Kiasi',
        charged: 'Kiasi Kilichokatwa',
        status: 'Hali',
        date: 'Tarehe',
        footer_title: 'Mawasiliano',
        support: 'Msaada',
        socials: 'Mitandao',
      },
    } as const;
    return dict[locale]?.[key] || dict.en[key] || key;
  }
}

const LOGO_FILE_PATHS = [
  '/home/almalick/Pictures/Medilink_Kenya/Medilink-App-Frontend/apps/mobile/assets/images/Medilink-logo.png',
  resolve(process.cwd(), '../Medilink-App-Frontend/apps/mobile/assets/images/Medilink-logo.png'),
  resolve(process.cwd(), 'apps/mobile/assets/images/Medilink-logo.png'),
];

const resolveLogoDataUri = (): string => {
  for (const filePath of new Set(LOGO_FILE_PATHS)) {
    try {
      if (!filePath || !existsSync(filePath)) continue;
      const buffer = readFileSync(filePath);
      if (!buffer?.length) continue;
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      // Try next candidate path.
    }
  }
  return '';
};

const LOGO_DATA_URI = resolveLogoDataUri();
