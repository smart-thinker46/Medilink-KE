import { Injectable, Logger } from '@nestjs/common';
import type { ServiceAccount } from 'firebase-admin';

let adminApp: any = null;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  private getServiceAccount(): ServiceAccount | null {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON || '';
    const base64 = process.env.FCM_SERVICE_ACCOUNT_BASE64 || '';
    try {
      if (raw) return JSON.parse(raw);
      if (base64) return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch (error) {
      this.logger.warn('Invalid FCM service account JSON.');
    }
    return null;
  }

  private getAdmin() {
    if (adminApp) return adminApp;
    // Lazy import to avoid crashing if firebase-admin isn't installed yet.
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const serviceAccount = this.getServiceAccount();
    if (!serviceAccount) {
      this.logger.warn('FCM service account missing. Push notifications disabled.');
      return null;
    }
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as ServiceAccount),
    });
    return admin;
  }

  async sendToTokens(tokens: string[], payload: { title: string; body: string; data?: any }) {
    if (!tokens?.length) return { success: false, reason: 'no_tokens' };
    const admin = this.getAdmin();
    if (!admin) return { success: false, reason: 'no_admin' };
    try {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data
          ? Object.fromEntries(
              Object.entries(payload.data).map(([key, value]) => [key, String(value)]),
            )
          : undefined,
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      });
      return { success: true, response };
    } catch (error) {
      this.logger.error('Failed to send push notifications', error?.stack || error?.message);
      return { success: false, reason: 'send_failed' };
    }
  }
}
