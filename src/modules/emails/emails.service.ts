import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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

const LOGO_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAfQAAACrCAYAAACQeW4cAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAgAElEQVR4nOy9d7wlR3Xv+1tV1Wmnk2bO5ByVJSOCiBLYxgKMjW3hh7gGkQ08OXB5GITtQTbCXMzF2CbKPMD3OoFsMH6+YNA1wgRxAROE4kijCZoZTTp5792xqtb7o/c+YeZM1Iz2hPp+Pq0z2rt39+rq7lq1Qq0CHA6Hw+FwOBwOh8PhcPQe6rUA5zJfXr8+aGTZUIF80Arjw/Og4HOeJ5P1VmPkGWPbpnoto8PhcDguDJxCPwG+vH79wqTm3aBhXxgK9YyliBb6Dx+kepFB+m0Y5JChjzjJYC2j6ldg4wLCC4HBwe1ptXLnqBLf3t6c+Pff2LVrX6+vx+FwOBznH06hH4Wvb7p800DcenWt0L+eZ+21mSggAx9SAHUvPDggw+9Pjk08ZHwFIRRIWxibQ/ZFyNleUhf+U8b3HRwOoJDkGSoLhjDanMLwoiXjU3n6103wF56+e/e3en2dDofD4Tg/cAr9ML5w+eXDjdHR/7aoXdwUpAUQKNhKeM9UJL+SEN/5vEd3ff1kjnfXkiVX98vwKsn6WTXPe4VptnxkGh4zgsYCO0bVD+2qBH/8om3fc+55h8PhcJwyTqHP4gdLVtxWF+ktNm5BaULuVz+2P/T/8Gf37h09Xee4c+3my/q0fuVS4b8jHx8lbTKE/VW0Q++Wi7bt/JPTdR6Hw+FwOC44Pn/V+oXb12x6YE/fQt6xcgnfvaD6gX9fPrTsTJ/3u+s2/vqjG1f/ZNfiAX4E4H3Ll09+Y9Wq6870eR0Oh8PhOO+4c/Payx5eumj0YVnl7YvX3P1Py5Ytf7Jl+Nbajc+eWnbx6H61kB9sDPP316z/4JMtg8PhcDgc5yz/sGrVRY8sWVTs7evjR5et/USv5Xlo+eV//vDgCr6vb5gf2XzJri9u3ry61zI5HA6Hw3HWs3vp+p3bvArf0+j/s17L0uVrazddvW3F2uYj9QHeu36D+beNa67otUwOh8PhcJy1/HDx+r/c4w/w1uEV/9RrWQ7nS2vWLDqw+aJ993oeP7ZmOX99/ern9Vomh8PhcDjOOj53xVOue2hoOT+6YGnz82vX9vVanvn4H5cvqu67+rL7tlcCvq/i81cvXnV9r2VyOBwOh+Os4rtrL/rOA30L+O4ly97Ua1mOx+Pr135n/2A/3zPcx19av+qqXsvjcDgcDsdZwfcuueqKbY3F/MDKladtbvmZZueG1Tu2NRq8bdny9N8uumhJr+VxOBwOx9mH6LUATzb+43tuUXkb41K+s9eynCgPsLpC9PXvD1MdrI/1T+66+OJar2VyOBwOx9nFBafQq759eRNtjPj+P/RalhPlRdu2TT1Yr10VV6LYjEwMD8b29l7L5HA4HA5Hz/jypk3Pv7/P552rltzZa1lOhf+99pKnPhAs4gejYf7B1Ve/tNfyOBwOh+Ps4YKy0AWlL1Ak0MqKc3KVs5/dfv8PUBt8a38hEG195HN3X3LJYK9lcjgcDsfZwQWl0Adt8WzBQAH1n72W5VS5ePTBj8llw//agAgXt1p/22t5HA6Hw3F2cEEp9CWtZGkIhUJU7+21LE+Er3nxK3UjTPNDo79w9/orXthreRwOh8PRey4ohT6osaTKEuOmNdZrWZ4I/2XbtqkR8n4r8BsYtvbzvZbH4XA4HI4nlay/xk0Vca/lOF3sW/u07Q8FNb5//bJbei2Lw+FwOHrLBWWh+5UGYM8bfY7tAq+MPIWhZvu2r21asbTX8jgcDofD8aQwsXjJVLPSz/9ncLDRa1lOF9uWrbpzvwx57CxY/tXhcDgcDsdZy/FeFO1pWWt0nj98Xl2mL8tRmwq9P3mJ7p3t1m3sHf/+FW1n35S0OsrNblm8++q2tSlBU0qsIad50qt4k03b6mxnWP9i38vC7llg0NUd25c0d1T9vqoRXs6e8O4scx3f7n42cM3tb+3rY1hzbIkgNMO7AEgs58v3D4K9iB//vTA7fvtcCKGTEj60c+Zz5tE9v3D3bCkba9wG0R2sFq2t0FvOOs97F3I3P5zzxwf3ty7ib2xaYhJh5tE3d4gSdpSO4bB0pPHZm/duet2VZcFq2/aJbK77UlM/MN3wDRnO6Tm9zPKeF0X1f5NnPGrtvzToR9zSKvV+v+c7PZab6Q+Zbks8k3vpc2bOSZs5X5/te4i4CQ/lp5yhwU81bQiswR1j3scc4bbNwqtkG2PS/l5Gmpq3rV51XPrb86uhAPwCe8nhikXzLlo1U6nf5OWpqxptbDi99+MlX7k0dPT9/2k1mLWuGuX3oqj+oEDgVxfyoT0vts6u2GW+Bw+e4pTDlrxmqtdHw8Pbtf2vkm7Lkv74LD9n/Aoo2q50uR5Se78AwdpvvKOwm2fsWmTw/l16nP1NWD3pT7prxCGvlu3bTxfxNdP8F+mF0aE7z7n7VZgkPmh2s12bLOUuFhUH7nr6HaIE8EsLY1i5tbBwA0J+sEc2+K8n0PW+okzFwy9xDq1IRt1x9/kV9N9t65Z4+4fDFtQ4ffyiCDo4dwTeQhgXQFMLLMjv3fw+6j+3ZfyzGx/4hzrP3P5u5nKH7L3YjplptH2J8jm45hrA2e8cx7T+KaZfTsk/0vmybJw/veVze/2cUE43XzTZbm4uKJghPvGZB9fZfryz2J7z8Bv9l4y+3xcxG+tkZ0CoDWXyMxf3Tz3H3haUK6V1Qe8Wb33T7P9T26/2X6U3gW2YB5lGdKqqgpxfjL2wQ3P6Y0q3u0o3rMtkLSoKOBy/9u7b9o6GL52c7vZvXoD1g8F7xm5Q2Cpy+fRND6ZwjkY5PJk8FGG3gcmxS0d5jGNvYdyPqag5X6b3Z4DZcE6LP3AA0fCGU7m9WdeO7j3rQYrlqy7bZ1fYWDXfv+bjL4y/+8Xv7nt03Xu+ZJd3IfQik3JWxHUpFf6B3eYwhK9ZGU1n3nxbmFEh1NqzVwJ3TOJcYG1oIR9X+fcwBvfN2hF6e8ylhFZyjEY1+EDB6HcRzVvL0ctfBNnS+cCrhLyLvN5jIu8fZtD3/zHkWHx9Dw5iJfLj4DCqzz+iY0fPGAFzkfoA1wm0RWnMQssI5ljyT9sZ7dFz0zXo2eLCWNvOZfVVle3JcE7+k/3r1/4xNwf+H1r1YeI1V2D7xx6Jz0F+8tC1L8J6zg0bJk6cyXBm5Ttk2Yq8P0LSgF/6ovr9Jt4vA5afKfIMdYLGhpw5QhT0mU0GyIR2vQKNbBFMCeacmFqB1K5OZtS6n0y4RO2uA5f7U1zwCHGhjpcGl6/2H59zv+n/+HbWZvH36wGk7zZgqV/0Wqv1b8/fE0mf1vCeyvM4SROOhTTvJ3Um0bFOKA0Jc0ZQ7AO0rZ0qgxMZ1iORxeV3/Rm9hT2zZi2VYf2x8IDSRnAV8U9B+qtX7Yk8QyzQEVgkD4k9tmgrYunMzb/0xJxJ2qGLLf/3et3l5a0DW+7qHrgngdJ3HINeukPBxa8rQfZgyb3/ix57a4e2f92zCbC+7OcsJbOKHCs1Xf7/7PF8zO18Sfxai7s9TpzOHIiBvCbG9nXLu6pHz+qadNdK8yUSx8g6r6Zjg4TZcHriTAgL9NDXdn36V0kH6AXMrN+5Gs2Jw7M8cPpXayrk0gtuEVQKFx1YhQ7ZYLf5q2Ya3xzq2hGEM4XQ8Sojvu4GKH7Z3EHdPZpujtb5P4upqS+7Z1Rupt7uKjMEAcHKbxe8cwFlkAkm9thl8xpzq/0f/7j9VZwKXQtJfuk7lb7zBs3f+8J/Y1XwxTnOQLHIW47ZeaC89H7sYd4VLjB7t2xvYmIp1Ow8rfx/Ce1A4HC4m4xnr8a+vD7uev8TtAO3TR0fOX7i8N7ib2cYQibc0ZJfXv9hg/t/XO4/wB6NaHUpEUyPr8g9O7v6W6/3lNhMbXcX8Me7z8ydt1P6YXR4ffdmXgBxr2e3dQFdXo8sA/vhzy7eQPc7TANz3+u7wX7DRwtuYLV2g04xw1PTy45ob8XzHbx/vo5xU5Q8URvD24pPe0bJoX6r71J2iAe/qE3Y1gUhgAFM9aQBKZy8ZbANftoO3DPMPrOOU3OALpWfGxZED1n8aVpQz11YtvG3thkIkqedH0Tflb9vftm/3j3fNfK65bmix9cl+Z4h9f+OU/f/bX/0y8h9HkZv4+o5eo1KzB1C0lZ5pC0ylhYl4GkkQ7JrmWlXRERDKhpS2Bh9/2t5p9W4Vd0oWwMXkXqlo3y4Ak8RxJbrEUTjDvOANcZVh2GErtt2SVF/3Vj0pbGicXXBiknsOqW9zTYObIujz+RGM6wCInx2oC2h6b9USVY4bAlhxzfYgq/7uBq6I+oRoDLs7MhjAMJMU3cTce7sXu5nkhfsq0mtQmoqO7u8iQhjxh4gkzEIPR22j1TphujKW0N2FskibktBIxMbwhZjTQLW8bMPeE/8GcchGyGm9g5MjT5pLp+3Ibxu+pDw+xJ7R7nD1w3r8FY4Y8HjqC+fU5+vV4g1BA4ga0cAK9+9yl/s4m42lppD7GSjeprfN+LA8jvLy5Xm19cp5snBmtqN4eD7M/3tdYsK3e13bO3F3oM17P9gVtB/6wUA27b5hKE+6O7dT85PUF6N1pft3LDoqdEZGZn01Qnx36Xykq3G7TiHPuj68s6xRY8Nbfb09QGJOpeO34XqxGjBPwFC4etuo5+1qv7X9T3wgS9f2dE0D1y91Mmvb7Q2M2yf+gHj2ctgNtjhefrwI0/jtH3bD5/fzuTbn3scf8jHEis6t/ycrfWcGxtx47Gy+4wDydxVX2TFU0w7opV0zPN+Lv1C0P0AjRjnjgVZzlsMQYYxRGDxKNSxCvwfdvB3R6+e+lrFBb+T6I9of7od1QuSzCstlry0sk9s8HbzNer/94W3f0xnV5QMyVd/59bb/28Rz/Q5f2Nxlc2bwtOyoHUv98ONbSy47DdYbYB56MmcxWhLSYpc+FN2OuTo6Ca+z+XTHLs9frPboF04ooYj3B6gtKhi5nV+iqnMFaIrxiHACv/htnr5scj/2jr1PAl/6Q+33H1kbH4YoIAJsG9BEEMWNl5x6W9ZpDxy1E1HAZGK/Br4qWbt6d/fYCjO7/9vfeO27dIuDWb+5ssmR3J5lZmaGJ9B8FFJDwI8CIAsHF5feK3BD7x/5+U3DVtm5kp0g5tB0Iey4gdDWsLT1fNiFK3HjvOit5SnnrP+z5TFqACscI0Ml3Y+5+HO2VXxPHzou60/lm7eP3uoI3/B29vYWC2b0xV0lKhZ6+vGDucr5aXmRBbAF8x3S8rT97Yh0i67/1o+P28vCr4l7jiCB6bRSWaqOT5iGqYJYXP7Hb/9P1xQ31eY1U1YdbahLRVjwsDaAK9lKs9u3o5rHp2uHry7tQQn+1TbFe+8AP9TFpfKi1OQLF6sv2Z5OtGu1sowh2j3DlQAQd+0JXgwmSqnKYyXkNyyglnZc8u6sL23dZMlV0yU5gu5ebfF93u0bDgu6r7E7TKxvui7O/7v+9E3jZ1w8j54Up2GWZpRsCC6dEY5RRD1ZQ6TEVEp9A+S/M22cK/9t8r9bPz02t3zP8Q3D1iLzqPn8dE5G6O8egQh4oH0Zrbz7L8gY4wz9oxT1Rx7Ny2YVdvYw+M1Yj/6Hto+cc1yt80iqXCfsN4q/4xLrEkl3d4rpsLsNF0Xl+9pLboQ0AGgEusYjt27WBhFoqtkEtGU6c+zzcSW2ED3vqS5d7j5N9w4slFHAotv3MDsK9GmF8ls0h0eCJeA0gaMa4mBLIJVfbLXnJO2s8Os/4gGbnYJtYQ3HHLme8O6cb2Xn0/w6KxhQwZQx2sIvm7PIQ1pPX1fSKsQeQgYgq1kw24wjXKFVVgRUs3hqGuEYOK2D8K3Z6b6DJw5GSKfhv1+3+lW63aXqtv2zChquX8I2xWW8gCwkO+sGctAxMMNMbK7Y1C1VmqQszQ8nM4X2qx9Z5d12jR3JKzRPBVs7yT9/wLbuc1X4fYoZ5ArEBA5gzddFzntKlf1bZgX1R6gJ7C0x3v3erW+33NPN8mv1TcbV7/1m7zZbqRPP3Gkdm8+5MpOkD7NNBEgt8cvBAey4XW09au5GffpV7wYXqGJ/xVDX0PNyN6f/TWvKQ/vAx0tAp7CLsk76x7Z8PwBf0/f+0Y7i4ApZWgfSFCGZ5XFCAYKw+L6hAytqnUvfSaRy0vwQFWNqurYxawGLh44yJg8XD7BNQ8O8krkK9uzU3lH9n9e+P337fzMz2R43L4fPy5IlW4cLcCklpgrJ/oyzxqq/4cBiLz5fE71ibTT9H7w5sZ0y8B7pCkFPjyx9pu366f3Ge2RcsFLtP3fpH7720oOr+VwVO8cSuCjvuKz58x/5Ol8y1hxcG9DWwNIkjcHmKsMIQ9Sl8z7rcx6Q6qoUnVPEaiUhuDhrfYaWrDOPC7a96dDfL+f0H94EOPIr/nltylYEs5bJQaMoHu9IfQuHCtH8VDHOPdHSmQSio5q6qE4jUCBK26g+1cdYQ1p0B1rRU1KIJWEA9bwOlqwhQGhvtBQPS/1rSu1M9CaoaTMWfZjzC+a2G1P9cseGhCBiD6S7AB4VeiSWNCuUDZDlBmwACCoYX+H78lyWEiU6jwQAAy0YWgffk9lCWpdsTFI/z/EnD6DsgUG2DtGVbHRWzLQfPQv2pkE0ix/johF5ji5uzHe/W3bsA4ipZI6RGLD9m37wPQRBEaJ7oiPYO+tL+0G/afz3sYV0P4n3Y5l2Du0yUv4QCJp13GOk4qLYgpl/baHGqdafeAWOpQXy2MVNbCecfHIAAb6tLu/hG0p0UQFiDjMj+hwAHcBkEjvsEYpy9PmK/9d9LlOjYaT8sPHGdwSeP76bIE1gI4AUpXLqVFaxzd59l26+4VDP5cTJkzV8vP2jFNBy9F6qRwlgbH2sOtx/4Er+gDU1iwO0mCJHcWuzAb7j4+63iAlT84vXtlArR7SdyQt+kI4+u4iC/5kuBUnnziOBZ4B4BDhs+2TG9MNWawq57MPAzJPMlO63G6aAcAiwzVX6y7QxVBBlhc4WqqxDJ51RneF0Mu6yXSVj2jVyfx5px8HLe1g7SFar32ZbQ7Iz1/DKfQHqN4KAjC4uUJ1+6/WF8te/NJtWz4slq48doT1h4nfCVZaZWLMFg2djz4h2RYy2c+nb9zdwDSEy7m9ve93sxjGN454tbXOtCecCbK2Db0wfblgEtAcC0X/xhBHbFscP2e8G5Yn0cc59es80mDP+DUH0P9k5Wtl35zN5XxCB2oYMs0HVt9pjfDBb/uyhED60mVsMuUMmJ/QG2WAyYfhM7fREfRE1vdkhoKGCtGCde+4XBy39+pnG6JMhqQJAMj4yLgx75xu2BR1hRws80CXAmJuMlx8SQPg2dHBCrVWotbkm6/ypzVQGxwIGR7SFDvDcfObbC1ujA+sF2rRAVn5daEUxm2vZZmmGnaOwycwUxT0Vt6spysT6fNrOi6ogwE9h2TslwQKAsxm/hZjDWpDhAOTg6YjjYKmG7h69ZFlqiUCecjnxmfp8RHHWB7n0E+wEx04yKj4zz8Rtuuvb96lmJsdDp0Nh8Zt3GvPBiS+apytESx2jXUN1D839gwrF777L6ASDD2KRzcA8CFbI2fKh3I7ycK71od33NYONI6NFQU6TltAX2PSNVhuV5vu0L6J7W/at0dj6bAsALWh86OX/5NPMm5o7DnnIkXhpac9rT02Y1Q4VhpnyMs+QtE3R5i7V3b7C5R8oVnFCczkqLYgo3JlB/76YrBg7t7OVdwAMOoQx1gl7wJaSG6Y1auR59jluXX7g8c3+4QYHBsRj+0uHTo58PPexBOqU8KRHoCRLdPsj27pSnnIF5xOqwpgmkFKDxT+KYzxnNowv/E9e50HK3tftf8x76rrz7H87uK/OY1KWZHh5EHkcX2ynqT2FoU0FLozpB9owPbvCdu38/Ef/49uG8uPKKzMTs5cVCWZ5YIn8trK92BAGDI7/bMpBK9xfm90lu2b34ACaN3c8jyv3VQG8OYbwiFGoGga6b0Vnl0R30MJkD88OV99+zP6f/Te1w2tFaT3DO1SdbpZfsrkGKw7ss/tyBB40EAMMI8/ct/atqSH9FN+yyfRTTmOuMuCItAoidyRMoKwLYLKANc5VVQgjSGMhK2XPklS/HGPd/1Kv2PnE+BlQoyC39PzzjW8cPv3A9mZXKWZ5w5CiVl1W4BBgfhzDx+w5Y4eTOylq4YTpPQGyEsfW5N/D1klp7/FqLeD9PjfD+2b1VdDCkE5Ra21h3F8TIgBNhFYMWPNbwjSCMfjlbgbHnxf1gZnYyi7O7o2RtBwZ3Hve+d7pprsgS8988IvHZWXZwO3fL4zc5KTSatMdKTJ0qqTRMgZfnpZqBc8xEoVyy+67GnH+4feR6USDMQEGcrrODNi9fjS01TpxNuvg44TxVX3Psq1Ug96zL5MD/ld99OkXxWTHE6CyIkK/qynRVrtsQsGkFtkUEE6dPVPOMrrxit8lZMOndyW/QUGeOznP7J6rn6Ve/wmjrx6bY/lJbJJ8vvjrurOClwbQ/Mf9L+vrnkuxz3uh0ByvvrcPdSfvPwuB/u33qSx7prX9w6kVLPTljRE1i5oNSgi7A+IzyZyLMiwdRDY//o15re89+1iX4xLRoBhiEyCiLMAVp3j74hFxBx5PD6Nmx8pbkl8hpfsa239ks07rFDUmFmw5+tqv5ja9f8MnrIt1XRRXVPc4/YGnv/zB50SZDAwkvEvqQwCxUo/XtQvoMlbvBFl/6cDCQ7uGbH7pspuFO1oY4RP8ck5F1v/je+46oyTsP2Ls2Ly0Ax/hVm+SDU7Ik/tdvMjVP//I+2/bK+Q0zOe1LW4/YHiUZ7C46Pl0lEQAAuzHYVJtS1Opd4k4lmhHQ5FkpCfC03/3Ty3OusT3EfDt5jZhX2tf+7e3d73r9y5+sjX5A/xxFvQKxEQxJZchxMTIjIwVUUFdNI85n0cpWj2rrWslOEwEqiCkU1CfG2+/B08//XINbM7lKQ+lujO8QuTFa7v3XFX+YdASaG7/yYeb/+rf+Py0T/15w7M8QD1ekfuNQBVnV66QNYNcRUKfgBlHULtZCSWtd7jd+XebW17aikm1+osO0GIm33MJR9V5W27c3K/2+5LlB8cg2YoXR+eT/zpM994OT9WqxpK/L1bdV0b1Q0XZSInd+2ogb/8jXettpoUVur8QTMjTP55/+D+0kwPZ4BOKu+8ClIHzXbZrv5ClvQN5JOtX7Y+/8rdjweAO2951y5imMf8Vq0o/5gydKf+8v4hdN9M/Z5+ptnnPN3F9gY0qjqtLi7GAZSUD4smoZLrqd8N3K1VnD0jGJvbAvcdVjK+JF8RDIC1W2Xm6pQW5SAJgTQJYZAog9gs59g0bzznwtlJQbKqggsDqzBwd19ldp/7MxbS2lzxj/4Az6H9C8Z2te/wPH7b3q+a4/2lgvgWSQ1z+LzAAzgbpvQqks1uDtm3eNwxeDo4IJTuB1y8//JqbVli7ZC1gxK6GkwxIF4ZzB1mSrOtz2PZ2tFVvd1+6efPDWzdd/+kvh+2++0cnW7/nyXz4a9DGsz8rGKfIYC0LR3z749Cvv++72l/s6Rz98PWX7Hz+LF63qyRXjopyzPjBjhHoTJY8qsCpNB4n7P0Zuf3TeBTA8Y/5UO86/fXwaF/ia9fP3XbHxSduG5V/gY4ddz/aYVxAZzN3r3T5Y8r5MTmrfIGMvO8P2ssXx9Np5g4fxkn3Inpd+2iWO8QsFNr1nHI6CG2b3EgA1jqXa/lRaT7lLiGJOLhiyis/O3lSbm9jdGx8IpS2xfuEjEh39tl3nJBXYF3g3FFKX3w9Zsu1ouD0XSLJ6tACUdNKM7xj2nDzQoO7mze3A+BvrpvE1vgoE2y9s0Nlk2/+mefvvvLpMzMsX/I56EyVRW0xE4k1EApyFPB7uPUe64+WssQ33f4Dg4e+9xL+M41dO4KsX9h8cdCqdxrfJTn0hMsXD7QyIKA8f8sI/8h6b8K/SXfHb2+yLOexsO8PWa/vRoZwblkuUtzhBIcQJmAe7c0/PbXB5blqY684+KT2q3HT1j+/W8+67WPPNWtnL14Tv/vob++e9/fc2s7v/MgKnLw89x5Jv4s6+sXyQp+qy2x7Uzcylz/Ceqf6ef/E97p5e/+PFqv0JsB9rmp8eiAo2iP/vbMH1KKObn0vHDNe6cTE6f/4TDX/Ge6+RHVOGrIgsmuHF3LxxoDTgHWrOjfQ1f/6h6s1UfL57/3z/4nj44vWFfA/7c7Z8dY4sUPy/y76cWbiuegIvz4oICzTjCcsL+9pSc57z14UTpBtlHgDTXrxz61ZX3/kYy3/N3e/5bmF1NzrSUdRyOd/cUFAz2YR6dKVTt6DH1r1n3rRH+0uOSyqWvjt1khEr1aAro36gGv+Q6aVRxWJKq5wwx0Jlu54f2mAI8/+KiZ3tfgHgklDlb7NRjB2Nxv6UtuBnGOc85HB5R5Gi1bRR+uIA57m/z50/pT3xqkE8JvSGinc2Z4B8cPbNU27Rn/1h/8AuSvwjc7scuLT+cWZry4LAE8sYMnNXcC2oGOmpazV79wxwi8UnlUs3ddc9j4xmxMSk8pATp1Zemv+2k//Xo3Xf6OfBamJ/F6MXoVvrn3sh34TmR0HmPExzWZCIUw5b90W7hie4NW7Q93s6FawLGBYAEee6kqI2HuWbD1dXhH8rCD0a1ZjjAtTDQqqKsK7GrB2OXCiX/1D/+IMwOfh+RLwBEA++O5sLkXvSWG/9bD+/1jbzKo4+yjz83f84J97WHFTcXHsM2/2AGCe52zdkC8I9B53l8h+cNJH0rb0XXfca9ePP5r3fL4qa3fxHyg2BfY0/xIgiRxCFFlWAMJ2W1FXvaZS6Gw3piAvIfal+1dP+f7rH3+PNWNfE9X/p9nXfcpxtgNKhv6wRlTCCsFiCCkKAmwCGJAsMSuhc1wOB3tUN1ISswFiybBADkRcz0hnWqzbqPkn/wDrYnHOK2JHE60hRIQf/o7a2P4dzaa1In0OZC8teAXPKdRw6XZ5kKtPxD88++UvfPSL8o3rf8F+F7VdCnlVmsjS+Y5RGltd0XM8om76MM0/3vCibcZd/kWy6ytTly93prfDLtbk88UhAxeC2qTHKFnkUAe5X+t5430Hh/QkGGnSuQ4+RWEyBqHynkhwAYNfbDhgxiLIbq/jOYBlnXOJ5zDaq8VHpBYxgm2JwY2IP50Bw15oV7z+cdxHk/4mSsYMQWya2fcexX/+d3uOtobpJ6cCo4poZUhggP+djA9AzqjEQBICsIF3SiAOR7h19d563snv/9D/+IZ7FGx6c4LxYts+QpXS35B2LUKxlEVTHF6cadZLXBQSR+4ALd5/0Rf5Q2vHqZa7c5Qbgvg8zmtL/K1PYu2bY7u2e6enqL3mx8fJIfemP97tY+L25hYPU0CiEj8+jjKTH5+PEYUNR4WsNuYl4S7erLytc1FYhOD9KrM9aNz9/6O22cCIf9wx1f+vVXv/6D5oeoujnpBnWM3h4lJTFaYjzkdW91e4x00c0vXlnTY61A11PWw+R7fJrnbNk3E2exOL0aqoploSBa6hn22dylSx9dF0dpZmqMfEScO1t/3lClP/65H/xH+5gr7mCvCHmS6E/Is8oP4zXCz0VH+tOfOu+sz/u4tPrsAHvt3r3L5fo53iV8+OHJflr+vHKp2DlK/1tkGbav72cJMPEKY5QGoZhyHlM7d1/1K1xm89LUkGIjSy5rWe+rfVxL9+LH/eO/9o9P1N68ZUe/4fzHfP2/OesTB64+du/TJgL2PQ3qr/iv3/spK6/4Dyy3/+pHeP/VId9PZrZ0f+TGX+K6P1luf6ZzXYl8Tj64t1qaD+SOKCfo11f+KI/hsEI+xn5rEfPBxCIXrvjuvGtS5ZJBrK8ELpy0vKrm/k0txjTKlf0j3P5xRN01co9Jiyb8O/bj3/ocXfpFLq/9o+pFKuj/NYTU+8WvPvboq4ImilOJsn1Jqu/0TYGfcuw/qpE+tsns3nnE1grrpq1yeTDgJ2zUydmXdG3d2qK2pfHYY+eVL3r8k791xVfCmff+60CYGBhvuW97+kc/4+Rn3YRI/a4LzoiSKzK+hs7H82BsXTWWa86Mj6voL600eNfU1KUBPBCd0BwqCONAWUEDp2F5xGohQWISF6d5rThLxxyLLO/D9eoueuLn1z75x8mW7e2P/Np73/z12bXG//aY4an95h+dxLA/6e8bHePHyWVVXzfemv04QJtA6mqOPmGgFqwaeD1fD1XalDcKXAsTf+Ifvbb35lxPh2jaUz/+HcBk1yO2f1+cg2t9x8eH8MdAhNMU4TtDBomjKO+Sz9QyzyTWuZP/5lNcuv6i1Avce+MvrPj4UmVBWef9ed5lwPcl3E0S0dYOLe7Ym1Pd86T+6zIrbCbJCiTW7Tx8aP6H51/7xJufYt/QBUiVWTTvXf7TP8ik0u4UyV9B3Nj/0pMrkQ+loUxVnBl9lgifQm7e+NGVh1+bX7D6j+T5X48X2gqx9L6+HeCjoQY7s4ouhh4DANgJKkQwdjfH3/cACa0xneQK+W/YiHlk8IRl1396xx91W1qPha957nvef/pZc/98qx0fPFJp6K4vUN2Xb6lSg3q3CDvYf/C1lwbRJFueZDhRpA4/USrXVW7Y9Hty76eGkIBK1MEcgxBXdhGm8/84KGVc2mB0g8FoMb/PxZsm33Er6JMV6Fmw+X/8x+K6w+t/4Kguu7utd5/3sE9q/GQZd9xv3HrlW8aOOmuFN6ltGm/8CSCQxHrHXlTPGTaoYQUv+LkJ7Xdrz6Jgd9sQxBCCibO2ApMnLR4/uDd25GIH8zbYu+x8u0Sxgl4QUMgO12dIOrj8cYXvij63tgE2v/6ycyKSsRhvQVLA+LRra3Bf+dCC6Oz0pY/c7/4fu2T3jpIBujnrw0za/+TI+nc3HlqvmLs+NYAWd0u9eGex8/8D5sC6NqT50dGGR40v9KXbpgR+HzEkF5yMHbNye/rnfjVKxLr7+kEg7sCK8DQYFNp18y/7QU1JP97wFfe7SbiO/91AJw1lV2H/+j37fDY9se+5H1z355mGcKuC4yhX2r/PDrs9duO1/68V6Crn4wtnhhapbSsOBxjjb6z0ecAlw7cW2rAcS7kInTnBS5g9r2rvfcYXN+ue/F9/wS8kuP/Gy84dMj/+v/7IbiDC/49YhOqRbw0mZvQ4BzcRSMwzDoFEM2eBVAkffbNyz8Yr8WuwZrXKj1CziERKX84P8AfPTai/6Ga+uYL4Fx0yLwHcA+gGrr9/A7u/ct9E08oD1D85E2+Gtvef3tu3c9eO8zdy7mp4uxkmQIijEgksF8b6cxoSSB5Sh2T2/Dq/2C1WsA0O4I+NVLDR/wxVev+JMFX79tS1dTKu2ZDTsfbkCxFIQR5/jiOCE7G4V5A/dLTycABEdPPO8n/8uU3rpP6H34o29fPQ7/9Yf/GW8Mf/GI/pmTQId3WvfthGX3/r//5/r51P4RrL3v07Ns/ezr6M4y+/J/6FkeS7/r8Rbzh7/343YGT9u1+YegyeKa93N3pMeepn8MQN9NRcB5hDs0Bqi0Yg3PTp0poYGoLryITLxSVIMxkgxCEfhJlEVH9Hz3OB/5+4pVfnb7VtvG2k+vTZ39k3VbLZmm6hCrShbyNUSiLLEcajgHN8ryigKN4oVI1jS2kBIChm5w0Xsd29fnvqk1V6a8x+EUWo84iQiqWct3z/9C3fFgizppQJcQJU+zckZKWXc/ElfbwMuWnWtpqH+Gv/6YS9Yfxyi5D79+ef/yJD+GOP/ma9cCEEOF4GGzbFE2Za/mnZbq3fg/q4Lzc/PzY1N1dX8a7z0m3xMNxC7lmb4kygeR9XHPha5tVvM0cYmxggG5YYg7ih27K/VYd4zCFB0KLpUBrd+stf01E48K2f2/fYLtp6zmzMHzoT+YYXvuAyuHUBkUJwAvf+ctd/d+LVH/pcf8fJPWNVnXrppWB/2ffP5pxRpGoK1IhzPcv65HkEwXint/2uGJgO4/F7PgfRhjAlTBAzNcibOkI+XzAh4/tzDX/et8EJ3rDwdCAft2LzXdrlH1kxdnLb+yIP3lGML8oJTkSUAB0yIUJmZ2U7BOcOTVzG/67/tLY7VEP8A1pY5ncNNpXHKYkdDkAWYQTsxQ1he3Qfa2BAKc/vl9t19+D7Foivced2AJbYtxx2mpKSqII0Nc+SOouByKHg1aa7vF9o5dd1w9FcXyIqBRH6B0dpIYxxJ+PP9tH77p/3yQX+51GhVj45t6cQ/81K97zqeG8uCpp1WF7p0P3HnLxa79oBvLP9c793e+97rnnk/2QmIfxGsFfuaX4/gweV48/uwOOJAHs+3+e9/713jM9/Kc8ni/yoGy3jz8xf7rq1uJ75WnzoVS44+4LkVRjCrxWmcNoiJMz3nZ0QSW0aP0M8EpfK/7Y1/4uXWXbkQ4Dd5y1gUQDF2AQLr3BeHlZs+oBzQXZ2PW4gjbA3QfWJfHs3I63+vZtn/5v7pxO2O///abv/GbK2Qw4d+jaHnzt/3Nkd7f6ud9sWaLCyIYgODYEGr1GteYwDmWOfm4Cn1+aBVV4gpFmBqmAQ8NQ4txhYmmM7M/ejVCv+mlQxOCLbtXqcnxRVJwA3H9jg2rH5jsDYq1LssExj0IzKoIA4r69qmxsbE4QswHwdpW83evh2lDWx6ebdHgjZs3xR+sdG13B5rqfp4D9YylMZUnQW9XgSwY38cxHeL1X/5095wi/67p8PW3/4zGTDCjWjAGD1V66fjzo+X6z0s8eEDnfQxgQvSYOYs93gQI+pv/rZvXx/vh8GglBgnBCh8WVvN89bW6em5AhWLzcdgMZIOeFYxwS1c1Y2BEECb46d+/WkHEQe+9Ds/p/2H+tdhhOj4vBcwpXK3YfBOyCBdZkjoGUmSE8HK29Psz2v8aUj9pN8JeH/EN/93+8sUK1FZgTpSuj0jgvZJ4H/6SvPwa5VVX3l1oAbd4bPylRxhoWkSDeKFGTnl4K++tW+/9/YH/8vX/NiMrOM8ESk/V1Iej4+N6gXUdYp9NGPZsCSEgPMBQn1RwmtrB1QxH4Zy1jWO/fx+o+0H0M8U/3Xv8qsweLxT2AcGjFJ1gE2OZTtGgx40x1BGGRIvXiV//sJ3q8GTFs82aehlbX352jEwLdXUtPTU+f0Z5A1BuOFtSgliMp7wCxuFcKuxj1knwx/5h1Xvd3gb1s5RNmBjIY63UsWZ/AcfOrNja1XVKJFhY10JDNH5/+qkc+8zUeWD+Mg5TteT7cDL1ON2UrB3WC8QxgbrDP0XXp+kwfm/3yvdVsXwrOXl9Bf5jxjT/uh2jPKR9+Y9+r50+//Kf7u1fR2cvLLxjsPLXjt215hnbg8s+WZs/KWU9y6ZnmObmUM+tfvjCF/3iB0W/m6Xnn++bVCz8oGI21AkiNsQAM8AyV9bhg8e2n0dK4ChWX9mFCFLOEUeE8ehdL9p+Db4+/PV/qazlvPq7P9v501d5ULvRh2dKvnHUujy5dXF5VZnSD9w/7eUP/9j1sqTL8jnBso4MreOAI6p0Q8sz8H7oLVyj7eiecmVHd/E74lE64hIAmvx7nk9qhkUJxdpPCrTmbMOoaxGiQw0NUwb74q8QKIvfNhqU3VVFHiI///d/utJrv/uBrDX/6s5/J4/rVWQOdf6P4fpP8OG3zY+Awg7jg/tkvnszH3HfMkxNUDQ6waTOhmlCnHuhtwuWKXjV/xT/8CzMzj736y6evPLsgw0Yn2ex3PWLJ4CzhCMWCx8LpxE7mD6Zye/qLJxPycTq5/NIuvX/vY5d/6gLNOoPLKy2NmIrF63u+tbz32ox7buX+5c2vS+bkSr/4/GeZv/n/vvs1SfwR2imof/g1D9xUKzMkG2BGAONyEEDKNE6xSzxYKz2HjsdQ1MsDnj/bUKBBZ+UWf+VuffuXyn/q4OnaX6f0uZvpeuPWjM7+4edKzQMAk2L73Qf4YDW9/giGMSJLDcGY+XDZhy9tGDRqZzaaKQFUSO5BR3Madd47+of2sx33k+5+HA0sY0Vyi4pp3ewunNVPuL3/rzX9qgOkSLzLnyN2CXYM4BkFPy777Y5KuihwN6NvzncHty7/wNfsh9CSk/8tixulztyxnuSB2gmwHtM5gAy7KNjdiAZm8zypvsNOfPsfvAXzV7BoL1A8fY8X/37NkV4HZ2cx8lYiV7ZhuuL9RHcdNzg3KdcHNBQH36Wz72P9u/463e9pbe1P0Hxt7l7L3Ah2fnQ2FDSbC7B+6j++f82PWf+jrs21T9IUJoHZ8mmVmtQfChRCbIUo7W+U6E/5qzzt2+GV8KrhVaP7PjPW/6mK3HH7s2/nJDmf2Gf+pHH6e3a1nYgeSJsK67rmf8zp4z7/5A46Ge+eSTJcVY+If5VwGwcjXwgUeeQWxu8YlTv/jY7Q0Dk5MqI5SDkwKv+YLLf+fPvv0auUpe1l33GTOWJ4ZycKmGFMnkTF8Rzf2D9ZfeCZbYT/KHeBR0HXPOgphua2ejoDff9Bw1r/5bP6ggX/rCSAIWJoY5yDnH3/37ft5qfrbQNKqnPoT66MmTp08aD5zQq+v3mX8QcQ7jY36UQlfL0SQEuGze4lyBWTEgSJM6OLn2tC/5b0gpNh/h/gC4A8C/DD7E6cBPrnxxUk1CXX8wt6sTu0TzlQ2ZcznnMWhLHXBt1IZCe/E/ZvF7/vCH/1Y9ncXmxurqme+75bcaIf7Vr/4TXCSfrDZPrdv//4Jr1+9l3A3cO1VfF6yrMQgQhR5cLB1/pw71wWPf8jNHH5EI3tjA/7Nv/T1vXbt5/ISNa3xypCi6t812i2S9C1x3OHXI5LynbdHLEHdbVzKkYzPxrWTV2Fv1CExOCzC9QWcmI4wwLMMsqzTKb3nncAdx/Ak/3rjm2udfd/Tdb77u+T0HpSP5i+7NN3PsfeM67/4UCjmBjR5RXTgxUlRFWknA42Q4k1eqHsp3f6Sm4VSpoG5r6eOPWFL9i175iFu2Z83EtNd//57+/V1vfO4+uFc96rfPym8dH3/S2eLVA9PIE4LZAGBMtsHW+NYt1+gJbwRlVqRkZ0LCeWmuOZ8E3sHtgTykT+9n/F995HX/xHXnn4acYAzXztutO3SwB5k4K2u/7el7ljRxI85fRjI4L/zz/zM3u3/rDSZFnXGyEq7qHHhYjjNuZhLVC6SOUJpxn03BaE7sEPVt/p7TAD0ne/v3KqLoGL4+Xbrz83tNt7dt++GL5jiLiw4OY2BQWD+Bw/vDcmbV3/vcbfz9f0ZjJsh/nj0mHAnAl7jdHfnU55X0bOp8xt5ql/8KBEVi1RttX0AMTdyI433xKnSB6rfPTQe5uf8bkbjBp/h+VDtwGvUSYYWzy5J2DGFd0UItvHQCDvbjklbVOkKT7ei93C3xeoBmb0kjg3+7du3f+cw8iTFC0tlf7HWBFt34z5DxUanPe8eGl/bVv81uFHnxr31AdSv97ld8ycNIha6xrA2rqmG2IOIeSSSDMLWwtBo4ocfm9o66cvu8r4D1Vf1/u06TP/5dD0ToGc/KBo3q1SpgwZ3hAsMgw8trAeZ0NxfP7tH9be++8HT98LxEWmf4dTO2jSmb67GMUI+ciEbnn35enVtd1vDrGY4b0O1dox41efP1Hxap5n7wvQACGq/mLZ9veefR8vP/bMqfX98Zf+56X333D9Y42E/ULz1750RsvRCYwrF3pAlPf0DYjX4CzUFC/iwgqUwhyyRiF2dlp7nd5KriE+eAHXdL+tSe4rYv8KyzWlG2g1p0MGV+c+YMsY1GF2VHRDHx6sOXlqKNK3wLS/EmBJFzAdB8AGIIf2c7weBWBnMePL0v16+6iR2r3uEnGiXRuz95+T84S4Q9YYA0V1uv4fc99LkWSrskFCcvSFWeoZoFSKv2GaU1OQFgDI3j9xB59bPP+LUedAKPU4Xu4M4Ate+Wa8dZFXhVd1V/OMbyZbda6c4x+MeeblHvvucnm/ZgF9H8uOCwEb9f7e6p3grCAB+xndc5GO/XIWOey8k3As9vf51b2sE9Hohac9po5bXtp3X9ZoKphzlP2RtefP09s5KZPR4/+dYLv/1KuNFNW3qV1ylrDZpwAIByUB3iUEvkUAuD98SC8Dzk/m//x3NmZ7uObZTX2tM2wnyNLZcWFRVhnMcBBsxM0C1oF0J0eqf8iSpF/Z5pm1Y4dIcYwfEJW7xUSUTUutE2BFWHDmQ4x/kgVQT7wlggbNWUZ3JTWgJi1pI7Hj+F0jrl3InYwZP08ndmYZixdii3HsYpRaZ92vcD7tHdBgsHx/7D9+8+ozlVRvv2W7hLDnhMzh1+4+gL1hk8uB8LCBJfWu7rZz7oi3/6nP+/j98E38r4n4bbK2f2f8Ivv7A3qwj27ijL0qsuAa8RCjiFUAEOM27UXvyCX/JrflxDPt939p9jnTtxe+7/2lH/4QxwcDn6qjMcEKClJTQ2ELsaYvz4z9zP1WrvYKuVyjpYOqf8c4zpC5KUUhpR+FHFcRVA54Kg5NQFq5tnr5PlW1LH3kMLidjSflAUR/KiM9C0lt7W0dxZzhOcT7rD+73c83gDfU1cUedk8csgTHpuTe6F7rPjv96663rzx7eNnnGGLDTEpboijB4ASpclqKdu5Y+ZObn/5CwvCExivbXaE3cOXV1/91tYl+0ia1AAAAAElFTkSuQmCC";
