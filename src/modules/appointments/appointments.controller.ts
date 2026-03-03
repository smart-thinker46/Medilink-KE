import { Controller, Get, Post, Put, Param, Body, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { ensureHospitalProfileComplete, ensurePatientProfileComplete } from 'src/common/profile-validation';
import { EmailsService } from '../emails/emails.service';
import { getProfileExtras } from 'src/common/profile-extras';

@Controller('appointments')
@UseGuards(AuthGuard('jwt'))
export class AppointmentsController {
  constructor(private prisma: PrismaService, private emails: EmailsService) {}

  @Get()
  async list() {
    return InMemoryStore.list('appointments');
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    await ensurePatientProfileComplete(this.prisma, req.user?.userId);
    const record = InMemoryStore.create('appointments', {
      patientId: req.user.userId,
      medicId: body.medic_id || body.medicId,
      date: body.date,
      time: body.time,
      mode: body.mode || 'video',
      reason: body.reason,
      treatmentLocation: body.treatmentLocation || body.location || null,
      status: 'confirmed',
    });
    const [patient, medic] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: record.patientId }, select: { email: true, fullName: true } }),
      record.medicId
        ? this.prisma.user.findUnique({ where: { id: record.medicId }, select: { email: true, fullName: true } })
        : null,
    ]);
    const subject = 'Appointment Confirmation';
    const details = `Date: ${record.date || '-'} Time: ${record.time || '-'} Mode: ${record.mode || '-'} Location: ${record.treatmentLocation || '-'}`;
    if (patient?.email) {
      const locale = ((await getProfileExtras(this.prisma, record.patientId))?.language || 'en') as 'en' | 'sw';
      await this.emails
        .sendTransactional({
          to: patient.email,
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
    return record;
  }

  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await ensureHospitalProfileComplete(this.prisma, req.user?.userId);
    const updated = InMemoryStore.update('appointments', id, body);
    if (updated) {
      const [patient, medic] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: updated.patientId }, select: { email: true } }),
        updated.medicId
          ? this.prisma.user.findUnique({ where: { id: updated.medicId }, select: { email: true } })
          : null,
      ]);
      const subject = 'Appointment Update';
      const details = `Status: ${updated.status || '-'} Date: ${updated.date || '-'} Time: ${updated.time || '-'}`;
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
    }
    return updated;
  }
}
