import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { InMemoryStore } from 'src/common/in-memory.store';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { PushService } from 'src/common/push.service';
import { EmailsService } from '../emails/emails.service';
import { getProfileExtras } from 'src/common/profile-extras';

@Injectable()
export class AppointmentsReminderService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs = 60 * 1000;

  constructor(
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
    private push: PushService,
    private emails: EmailsService,
  ) {}

  onModuleInit() {
    this.tick().catch(() => undefined);
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined);
    }, this.intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private parseAppointmentDate(date?: string | null, time?: string | null) {
    if (!date) return null;
    const cleanTime = time || '00:00';
    const iso = `${date}T${cleanTime}:00`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async notifyUser(userId: string, title: string, message: string, appointmentId: string) {
    if (!userId) return;
    const notification = InMemoryStore.create('notifications', {
      userId,
      title,
      message,
      type: 'APPOINTMENT',
      relatedId: appointmentId,
      data: { appointmentId, status: 'confirmed' },
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    this.notificationsGateway.emitToUser(userId, {
      title: notification.title,
      message: notification.message,
      type: notification.type,
      data: notification.data,
    });

    const extras = await getProfileExtras(this.prisma, userId);
    const tokens = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
    const unreadCount = InMemoryStore.list('notifications').filter(
      (item) => item.userId === userId && !item.isRead,
    ).length;
    if (tokens.length) {
      await this.push.sendToTokens(tokens, {
        title: notification.title,
        body: notification.message,
        data: { ...(notification.data || {}), badge: unreadCount },
        badge: unreadCount,
        sound: 'default',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user?.email) {
      await this.emails
        .sendTransactional({
          to: user.email,
          subject: title,
          html: this.emails.buildBrandedHtml({
            title,
            body: `<p>${message}</p>`,
            locale: 'en',
          }),
          text: message,
        })
        .catch(() => undefined);
    }
  }

  private async tick() {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in1h = new Date(now.getTime() + 60 * 60 * 1000);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: 'confirmed',
        OR: [{ reminder24hSent: false }, { reminder1hSent: false }],
      },
    });

    for (const appointment of appointments) {
      const scheduled = this.parseAppointmentDate(appointment.date, appointment.time);
      if (!scheduled) continue;
      const timeDiff = scheduled.getTime() - now.getTime();

      if (!appointment.reminder24hSent && scheduled <= in24h && timeDiff > 60 * 60 * 1000) {
        const message = `Reminder: Appointment in 24 hours on ${appointment.date || '-'} at ${appointment.time || '-'}.`;
        await this.notifyUser(appointment.patientId, 'Appointment Reminder', message, appointment.id);
        if (appointment.medicId) {
          await this.notifyUser(appointment.medicId, 'Appointment Reminder', message, appointment.id);
        }
        await this.prisma.appointment.update({
          where: { id: appointment.id },
          data: { reminder24hSent: true },
        });
      }

      if (!appointment.reminder1hSent && scheduled <= in1h && timeDiff > 0) {
        const message = `Reminder: Appointment in 1 hour on ${appointment.date || '-'} at ${appointment.time || '-'}.`;
        await this.notifyUser(appointment.patientId, 'Appointment Reminder', message, appointment.id);
        if (appointment.medicId) {
          await this.notifyUser(appointment.medicId, 'Appointment Reminder', message, appointment.id);
        }
        await this.prisma.appointment.update({
          where: { id: appointment.id },
          data: { reminder1hSent: true },
        });
      }
    }
  }
}
