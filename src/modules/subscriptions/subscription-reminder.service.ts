import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtras, mergeProfileExtras } from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';
import { EmailsService } from '../emails/emails.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';

@Injectable()
export class SubscriptionReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionReminderService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly reminderDays = new Set([7, 3, 1]);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private emails: EmailsService,
    private notificationsGateway: NotificationsGateway,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log('Subscription reminder worker is disabled.');
      return;
    }

    const intervalMs = this.getIntervalMs();
    // Run quickly after boot, then periodically.
    setTimeout(() => {
      void this.runSafely('startup');
    }, 5000);
    this.timer = setInterval(() => {
      void this.runSafely('interval');
    }, intervalMs);
    this.logger.log(`Subscription reminder worker started. Interval: ${Math.round(intervalMs / 60000)} minute(s).`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private isEnabled() {
    return String(this.config.get('SUBSCRIPTION_REMINDER_ENABLED') || 'true') === 'true';
  }

  private getIntervalMs() {
    const minutes = Number(this.config.get('SUBSCRIPTION_REMINDER_INTERVAL_MINUTES') || 360);
    const safeMinutes = Number.isFinite(minutes) && minutes >= 15 ? minutes : 360;
    return safeMinutes * 60 * 1000;
  }

  private planDurationDays(plan: unknown) {
    const value = String(plan || 'monthly').trim().toLowerCase();
    if (!value) return 30;
    if (value.includes('year') || value.includes('annual')) return 365;
    if (value.includes('week')) return 7;
    if (value.includes('day')) {
      const match = value.match(/\d+/);
      const parsed = Number(match?.[0] || 0);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      return 30;
    }
    return 30;
  }

  private normalizeDate(value: unknown) {
    const dt = new Date(String(value || ''));
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

  private getDaysLeft(expiresAt: Date, now = new Date()) {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);
  }

  private async runSafely(reason: string) {
    try {
      await this.run(reason);
    } catch (error: any) {
      this.logger.error(`Subscription reminder run failed (${reason}): ${error?.message || 'Unknown error'}`);
    }
  }

  private async run(reason: string) {
    const subscriptions = (InMemoryStore.list('subscriptions') as any[])
      .filter((item) => String(item?.status || '').toUpperCase() === 'ACTIVE');

    if (!subscriptions.length) return;

    const latestByUser = new Map<string, any>();
    subscriptions.forEach((subscription) => {
      const userId = String(subscription?.userId || '').trim();
      if (!userId) return;
      const current = latestByUser.get(userId);
      if (!current) {
        latestByUser.set(userId, subscription);
        return;
      }
      const currentTime = new Date(current?.startedAt || 0).getTime();
      const nextTime = new Date(subscription?.startedAt || 0).getTime();
      if (nextTime >= currentTime) latestByUser.set(userId, subscription);
    });

    let sentCount = 0;
    let expiredCount = 0;

    for (const subscription of latestByUser.values()) {
      const startedAt =
        this.normalizeDate(subscription?.startedAt) ||
        this.normalizeDate(subscription?.createdAt) ||
        new Date();

      const planDays = this.planDurationDays(subscription?.plan);
      const inferredExpiry = new Date(startedAt.getTime() + planDays * 24 * 60 * 60 * 1000);
      const expiresAt = this.normalizeDate(subscription?.expiresAt) || inferredExpiry;
      const daysLeft = this.getDaysLeft(expiresAt);

      if (!subscription?.expiresAt) {
        InMemoryStore.update('subscriptions', subscription.id, {
          expiresAt: expiresAt.toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      if (daysLeft <= 0) {
        InMemoryStore.update('subscriptions', subscription.id, {
          status: 'EXPIRED',
          expiredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        if (subscription?.userId) {
          await mergeProfileExtras(this.prisma, subscription.userId, {
            subscriptionActive: false,
            premiumActive: false,
            aiEnabled: false,
          });
        }
        expiredCount += 1;
        continue;
      }

      if (!this.reminderDays.has(daysLeft)) continue;

      const cycleKey = expiresAt.toISOString().slice(0, 10);
      const reminderMeta = (subscription?.reminderMeta || {}) as Record<string, string>;
      if (reminderMeta[String(daysLeft)] === cycleKey) continue;

      const userId = String(subscription?.userId || '').trim();
      if (!userId) continue;

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!user?.email) continue;

      const extras = await getProfileExtras(this.prisma, userId);
      const locale = extras?.language === 'sw' ? 'sw' : 'en';

      await this.emails
        .sendSubscriptionReminder({
          to: user.email,
          daysLeft,
          locale,
        })
        .catch(() => undefined);

      const title = this.emails.t(locale, 'subscription_reminder_title');
      const message = `${this.emails.t(locale, 'subscription_reminder_body')} (${daysLeft} day(s) left)`;
      InMemoryStore.create('notifications', {
        userId,
        title,
        message,
        type: 'SUBSCRIPTION',
        relatedId: subscription.id,
        isRead: false,
        createdAt: new Date().toISOString(),
      } as any);
      this.notificationsGateway.emitToUser(userId, {
        title,
        message,
      });

      InMemoryStore.update('subscriptions', subscription.id, {
        reminderMeta: {
          ...reminderMeta,
          [String(daysLeft)]: cycleKey,
        },
        updatedAt: new Date().toISOString(),
      });

      InMemoryStore.logAudit({
        action: 'SUBSCRIPTION_REMINDER_SENT',
        targetId: subscription.id,
        userId,
        daysLeft,
        reason,
        createdAt: new Date().toISOString(),
      });
      sentCount += 1;
    }

    if (sentCount > 0 || expiredCount > 0) {
      this.logger.log(
        `Subscription reminder run complete (${reason}). Sent: ${sentCount}, expired: ${expiredCount}.`,
      );
    }
  }
}

