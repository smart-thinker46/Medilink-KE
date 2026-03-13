import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
  Req,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { ensureHospitalProfileComplete, ensurePatientProfileComplete } from 'src/common/profile-validation';
import { EmailsService } from '../emails/emails.service';
import { getProfileExtras } from 'src/common/profile-extras';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { PushService } from 'src/common/push.service';

@Controller('appointments')
@UseGuards(AuthGuard('jwt'))
export class AppointmentsController {
  constructor(
    private prisma: PrismaService,
    private emails: EmailsService,
    private notificationsGateway: NotificationsGateway,
    private push: PushService,
  ) {}

  private static medicCache = new Map<
    string,
    { value: { fullName: string | null; specialization: string | null; consultationFee: number | null }; expiresAt: number }
  >();
  private static patientCache = new Map<
    string,
    { value: { fullName: string | null; email: string | null; phone: string | null }; expiresAt: number }
  >();
  private static cacheTtlMs = 5 * 60 * 1000;

  private async getMedicSnapshot(medicId: string | null) {
    if (!medicId) {
      return { fullName: null, specialization: null, consultationFee: null };
    }
    const now = Date.now();
    const cached = AppointmentsController.medicCache.get(medicId);
    if (cached && cached.expiresAt > now) return cached.value;

    const medic = await this.prisma.user.findUnique({
      where: { id: medicId },
      select: {
        fullName: true,
        medicProfile: { select: { specialization: true, consultationFee: true } },
      },
    });

    const snapshot = {
      fullName: medic?.fullName || null,
      specialization: medic?.medicProfile?.specialization || null,
      consultationFee:
        medic?.medicProfile?.consultationFee !== null &&
        medic?.medicProfile?.consultationFee !== undefined
          ? Number(medic.medicProfile.consultationFee)
          : null,
    };
    AppointmentsController.medicCache.set(medicId, {
      value: snapshot,
      expiresAt: now + AppointmentsController.cacheTtlMs,
    });
    return snapshot;
  }

  private async getPatientSnapshot(patientId: string | null) {
    if (!patientId) {
      return { fullName: null, email: null, phone: null };
    }
    const now = Date.now();
    const cached = AppointmentsController.patientCache.get(patientId);
    if (cached && cached.expiresAt > now) return cached.value;

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { fullName: true, email: true, phone: true },
    });
    const snapshot = {
      fullName: patient?.fullName || null,
      email: patient?.email || null,
      phone: patient?.phone || null,
    };
    AppointmentsController.patientCache.set(patientId, {
      value: snapshot,
      expiresAt: now + AppointmentsController.cacheTtlMs,
    });
    return snapshot;
  }

  private async normalizeAppointment(record: any) {
    if (!record) return record;
    const patientId = record.patientId || record.patient_id;
    const medicId = record.medicId || record.medic_id;
    const medicSnapshot = await this.getMedicSnapshot(medicId);
    const patientSnapshot = await this.getPatientSnapshot(patientId);
    return {
      ...record,
      id: record.id,
      patientId,
      medicId,
      patientName: record.patientName || patientSnapshot.fullName || null,
      patientEmail: record.patientEmail || patientSnapshot.email || null,
      patientPhone: record.patientPhone || patientSnapshot.phone || null,
      doctorName: record.doctorName || medicSnapshot.fullName || 'Medic',
      specialization: record.specialization || medicSnapshot.specialization || null,
      fee:
        record.fee ??
        record.amount ??
        record.price ??
        (medicSnapshot.consultationFee ?? null),
      mode: record.mode || 'video',
      status: record.status || 'confirmed',
      date: record.date || null,
      time: record.time || null,
    };
  }

  private isPaidForAppointment(appointmentId: string, fee?: number | null) {
    const requiredFee = Number(fee || 0);
    if (!Number.isFinite(requiredFee) || requiredFee <= 0) return true;
    const payments = InMemoryStore.list('payments') as any[];
    return payments.some(
      (payment) =>
        String(payment?.appointmentId || '') === appointmentId &&
        String(payment?.status || '').toUpperCase() === 'PAID',
    );
  }

  private findPaymentById(paymentId: string) {
    const payments = InMemoryStore.list('payments') as any[];
    return payments.find((payment) => {
      const id = String(payment?.id || payment?.apiRef || '').trim();
      return id && id === paymentId;
    });
  }

  private async sendAppointmentNotification(
    userId: string,
    payload: { title: string; message: string; appointmentId: string; status?: string; type?: string },
  ) {
    if (!userId) return;
    const type = payload.type || 'APPOINTMENT';
    const notification = InMemoryStore.create('notifications', {
      userId,
      title: payload.title,
      message: payload.message,
      type,
      relatedId: payload.appointmentId,
      data: {
        appointmentId: payload.appointmentId,
        status: payload.status || null,
      },
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
  }

  @Get()
  async list(@Req() req: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    const where: any = {};
    if (role === 'PATIENT') {
      where.patientId = userId;
    } else if (role === 'MEDIC') {
      where.medicId = userId;
    }
    const items = await this.prisma.appointment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const normalized = await Promise.all(items.map((item: any) => this.normalizeAppointment(item)));
    return normalized;
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    await ensurePatientProfileComplete(this.prisma, req.user?.userId);
    const medicId = body.medic_id || body.medicId || null;
    const medicSnapshot = await this.getMedicSnapshot(medicId);
    const consultationFee =
      medicSnapshot.consultationFee !== null && medicSnapshot.consultationFee !== undefined
        ? Number(medicSnapshot.consultationFee)
        : null;
    const paymentId = String(body.paymentId || body.payment_id || '').trim() || null;
    if (consultationFee && consultationFee > 0) {
      if (!paymentId) {
        throw new BadRequestException('Payment required before booking this appointment.');
      }
      const payment = this.findPaymentById(paymentId);
      if (!payment) {
        throw new BadRequestException('Payment reference not found.');
      }
      if (String(payment?.userId || '') !== String(req.user?.userId || '')) {
        throw new ForbiddenException('Payment does not belong to the current user.');
      }
      if (String(payment?.type || '').toUpperCase() !== 'APPOINTMENT') {
        throw new BadRequestException('Invalid payment type for appointment booking.');
      }
      if (String(payment?.status || '').toUpperCase() !== 'PAID') {
        throw new BadRequestException('Payment must be completed before booking.');
      }
      const amountPaid = Number(payment?.amount || 0);
      if (!Number.isFinite(amountPaid) || amountPaid < consultationFee) {
        throw new BadRequestException('Payment amount is less than consultation fee.');
      }
      if (payment?.appointmentId) {
        throw new BadRequestException('Payment already linked to an appointment.');
      }
    }
    const record = await this.prisma.appointment.create({
      data: {
        patientId: req.user.userId,
        medicId,
        date: body.date || null,
        time: body.time || null,
        mode: body.mode || 'video',
        reason: body.reason || null,
        treatmentLocation: body.treatmentLocation || body.location || null,
        status: 'pending',
        fee: consultationFee,
        paymentId: paymentId || undefined,
        paidAt: paymentId ? new Date() : undefined,
      },
    });
    if (paymentId) {
      InMemoryStore.update('payments', paymentId, {
        appointmentId: record.id,
        updatedAt: new Date().toISOString(),
      });
    }
    const [patient, medic] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: record.patientId }, select: { email: true, fullName: true } }),
      record.medicId
        ? this.prisma.user.findUnique({ where: { id: record.medicId }, select: { email: true, fullName: true } })
        : null,
    ]);
    const patientName = patient?.fullName || null;
    const patientEmail = patient?.email || null;
    const subject = 'Appointment Confirmation';
    const details = `Date: ${record.date || '-'} Time: ${record.time || '-'} Mode: ${record.mode || '-'} Location: ${record.treatmentLocation || '-'}`;
    if (patientEmail) {
      const locale = ((await getProfileExtras(this.prisma, record.patientId))?.language || 'en') as 'en' | 'sw';
      await this.emails
        .sendTransactional({
          to: patientEmail,
          subject: this.emails.t(locale, 'appointment_confirmed_title'),
          html: this.emails.buildBrandedHtml({
            title: this.emails.t(locale, 'appointment_confirmed_title'),
            body: `<p>${this.emails.t(locale, 'appointment_confirmed_body')}</p><p>${details}</p>`,
            locale,
          }),
          text: `${this.emails.t(locale, 'appointment_confirmed_body')} ${details}`,
        })
        .catch(() => undefined);
    }
    if (medic?.email) {
      const locale = ((await getProfileExtras(this.prisma, record.medicId))?.language || 'en') as 'en' | 'sw';
      await this.emails
        .sendTransactional({
          to: medic.email,
          subject: this.emails.t(locale, 'appointment_confirmed_title'),
          html: this.emails.buildBrandedHtml({
            title: this.emails.t(locale, 'appointment_confirmed_title'),
            body: `<p>${this.emails.t(locale, 'appointment_confirmed_body')}</p><p>${details}</p>`,
            locale,
          }),
          text: `${this.emails.t(locale, 'appointment_confirmed_body')} ${details}`,
        })
        .catch(() => undefined);
    }
    if (record.medicId) {
      const title = 'New appointment request';
      const message = `${patientName || 'A patient'} booked an appointment.`;
      const notification = InMemoryStore.create('notifications', {
        userId: record.medicId,
        title,
        message,
        type: 'APPOINTMENT',
        relatedId: record.id,
        data: { appointmentId: record.id, status: record.status },
        isRead: false,
        createdAt: new Date().toISOString(),
      });
      this.notificationsGateway.emitToUser(record.medicId, {
        title,
        message,
        type: notification.type,
        relatedId: notification.relatedId,
        data: notification.data,
      });
      const extras = await getProfileExtras(this.prisma, record.medicId);
      const tokens = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
      const unreadCount = InMemoryStore.list('notifications').filter(
        (item) => item.userId === record.medicId && !item.isRead,
      ).length;
      if (tokens.length) {
        await this.push.sendToTokens(tokens, {
          title,
          body: message,
          data: {
            type: notification.type,
            relatedId: notification.relatedId,
            appointmentId: record.id,
            badge: unreadCount,
          },
          badge: unreadCount,
          sound: 'default',
        });
      }
    }
    return this.normalizeAppointment(record);
  }

  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role === 'HOSPITAL_ADMIN') {
      await ensureHospitalProfileComplete(this.prisma, req.user?.userId);
    }
    const currentUserId = req.user?.userId;
    const existing = await this.prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Appointment not found.');
    }
    if (role === 'MEDIC' && String(existing.medicId || '') !== String(currentUserId || '')) {
      throw new ForbiddenException('Not allowed to update this appointment.');
    }
    const nextStatus = String(body.status || existing.status || '').toLowerCase();
    const statusChanged = String(existing.status || '').toLowerCase() !== nextStatus;
    if (nextStatus === 'access_requested') {
      const allowed = role === 'MEDIC' || role === 'HOSPITAL_ADMIN' || role === 'SUPER_ADMIN';
      if (!allowed) {
        throw new ForbiddenException('Only providers can request access.');
      }
    }
    if (nextStatus === 'confirmed' && !this.isPaidForAppointment(existing.id, existing.fee as any)) {
      throw new BadRequestException('Payment required before confirmation.');
    }
    const updated = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: body.status || existing.status,
        date: body.date ?? existing.date,
        time: body.time ?? existing.time,
        mode: body.mode ?? existing.mode,
        reason: body.reason ?? existing.reason,
        treatmentLocation: body.treatmentLocation ?? existing.treatmentLocation,
        cancelReason: body.cancelReason ?? existing.cancelReason,
        cancelledAt:
          nextStatus === 'cancelled'
            ? new Date()
            : existing.cancelledAt,
        cancelledBy:
          nextStatus === 'cancelled'
            ? currentUserId || existing.cancelledBy
            : existing.cancelledBy,
        rescheduleReason: body.rescheduleReason ?? existing.rescheduleReason,
        rescheduledFromDate:
          body.date && body.date !== existing.date ? existing.date : existing.rescheduledFromDate,
        rescheduledFromTime:
          body.time && body.time !== existing.time ? existing.time : existing.rescheduledFromTime,
      },
    });
    if (updated) {
      const [patient, medic] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: updated.patientId }, select: { email: true } }),
        updated.medicId
          ? this.prisma.user.findUnique({ where: { id: updated.medicId }, select: { email: true } })
          : null,
      ]);
      const subject = 'Appointment Update';
      const reason =
        updated.cancelReason ||
        updated.rescheduleReason ||
        updated.reason ||
        '';
      const details = `Status: ${updated.status || '-'} Date: ${updated.date || '-'} Time: ${updated.time || '-'}${reason ? ` Reason: ${reason}` : ''}`;
      if (patient?.email) {
        const locale = ((await getProfileExtras(this.prisma, updated.patientId))?.language || 'en') as 'en' | 'sw';
        await this.emails
          .sendTransactional({
            to: patient.email,
            subject: this.emails.t(locale, 'appointment_update_title'),
            html: this.emails.buildBrandedHtml({
              title: this.emails.t(locale, 'appointment_update_title'),
              body: `<p>${this.emails.t(locale, 'appointment_update_body')}</p><p>${details}</p>`,
              locale,
            }),
            text: `${this.emails.t(locale, 'appointment_update_body')} ${details}`,
          })
          .catch(() => undefined);
      }
      if (medic?.email) {
        const locale = ((await getProfileExtras(this.prisma, updated.medicId))?.language || 'en') as 'en' | 'sw';
        await this.emails
          .sendTransactional({
            to: medic.email,
            subject: this.emails.t(locale, 'appointment_update_title'),
            html: this.emails.buildBrandedHtml({
              title: this.emails.t(locale, 'appointment_update_title'),
              body: `<p>${this.emails.t(locale, 'appointment_update_body')}</p><p>${details}</p>`,
              locale,
            }),
            text: `${this.emails.t(locale, 'appointment_update_body')} ${details}`,
          })
          .catch(() => undefined);
      }
      if (statusChanged || body.date || body.time) {
        const noticeTitle = 'Appointment Update';
        const noticeMessage = `Status: ${updated.status || '-'} Date: ${updated.date || '-'} Time: ${updated.time || '-'}${reason ? ` Reason: ${reason}` : ''}`;
        const notificationType =
          String(updated.status || '').toLowerCase() === 'access_requested'
            ? 'ACCESS_REQUEST'
            : 'APPOINTMENT';
        const patientTitle =
          notificationType === 'ACCESS_REQUEST' ? 'Access Request' : noticeTitle;
        const patientMessage =
          notificationType === 'ACCESS_REQUEST'
            ? 'A medic has requested access to your appointment details. Please approve or decline.'
            : noticeMessage;
        await this.sendAppointmentNotification(updated.patientId, {
          title: patientTitle,
          message: patientMessage,
          appointmentId: updated.id,
          status: updated.status,
          type: notificationType,
        });
        if (updated.medicId) {
          await this.sendAppointmentNotification(updated.medicId, {
            title: noticeTitle,
            message: noticeMessage,
            appointmentId: updated.id,
            status: updated.status,
          });
        }
      }
    }
    return this.normalizeAppointment(updated);
  }
}
