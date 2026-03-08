import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  Query,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import {
  ensureHospitalProfileComplete,
  ensureMedicProfileComplete,
  ensurePharmacyProfileComplete,
} from 'src/common/profile-validation';
import { getProfileExtras } from 'src/common/profile-extras';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { PushService } from 'src/common/push.service';
import { EmailsService } from '../emails/emails.service';

@Controller('jobs')
@UseGuards(AuthGuard('jwt'))
export class JobsController {
  constructor(
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
    private push: PushService,
    private emails: EmailsService,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  private normalizeNumber(value: any, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private sanitizeText(value: any) {
    const text = String(value ?? '').trim();
    return text.length ? text : null;
  }

  private textOrFallback(value: any, fallback: string) {
    const text = this.sanitizeText(value);
    return text ?? fallback;
  }

  private collectMissingJobFields(input: {
    title?: any;
    description?: any;
    requirements?: any;
    requiredMedics?: any;
  }) {
    const requiredTextFields: Array<{ label: string; value: any }> = [
      { label: 'Job title', value: input.title },
      { label: 'Job description', value: input.description },
      { label: 'Requirements', value: input.requirements },
    ];
    const missingText = requiredTextFields
      .filter((field) => !this.sanitizeText(field.value))
      .map((field) => field.label);

    const requiredCountFields: Array<{ label: string; value: any }> = [
      { label: 'Available slots', value: input.requiredMedics },
    ];
    const missingCounts = requiredCountFields
      .filter((field) => this.normalizeNumber(field.value, 0) <= 0)
      .map((field) => field.label);

    return [...missingText, ...missingCounts];
  }

  private ensureJobFieldsComplete(input: {
    title?: any;
    description?: any;
    requirements?: any;
    requiredMedics?: any;
  }) {
    const missingFields = this.collectMissingJobFields(input);
    if (missingFields.length) {
      throw new BadRequestException({
        message: 'Job details incomplete',
        missingFields,
      });
    }
  }

  @Get()
  async list(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('location') location?: string,
    @Query('specialization') specialization?: string,
    @Query('employer') employer?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
  ) {
    const mineOnly = String(mine || '').toLowerCase() === 'true' || mine === '1';
    const currentUserId = req.user?.userId;
    const where: any = {};

    if (mineOnly && currentUserId) {
      where.createdBy = currentUserId;
    }
    if (status) {
      where.status = String(status || '').toUpperCase();
    } else if (!mineOnly) {
      where.status = { not: 'CANCELLED' };
    }
    if (search) {
      const searchText = String(search).trim();
      const searchNumber = this.normalizeNumber(searchText, Number.NaN);
      const orFilters: any[] = [
        { title: { contains: searchText, mode: 'insensitive' } },
        { description: { contains: searchText, mode: 'insensitive' } },
        { department: { contains: searchText, mode: 'insensitive' } },
        { specialization: { contains: searchText, mode: 'insensitive' } },
        { employerName: { contains: searchText, mode: 'insensitive' } },
        { location: { contains: searchText, mode: 'insensitive' } },
        { jobType: { contains: searchText, mode: 'insensitive' } },
        { scheduleType: { contains: searchText, mode: 'insensitive' } },
        { experienceLevel: { contains: searchText, mode: 'insensitive' } },
        { payType: { contains: searchText, mode: 'insensitive' } },
      ];
      if (Number.isFinite(searchNumber)) {
        orFilters.push({ payAmount: searchNumber });
      }
      where.OR = orFilters;
    }
    if (location) {
      where.location = { contains: location, mode: 'insensitive' };
    }
    if (specialization) {
      where.specialization = { contains: specialization, mode: 'insensitive' };
    }
    if (employer) {
      where.employerName = { contains: employer, mode: 'insensitive' };
    }

    return this.db.job.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId;
    const role = String(req.user?.role || '').toUpperCase();
    if (!userId || !['HOSPITAL_ADMIN', 'PHARMACY_ADMIN'].includes(role)) {
      throw new ForbiddenException('Only hospital and pharmacy admins can create jobs.');
    }

    if (role === 'HOSPITAL_ADMIN') {
      await ensureHospitalProfileComplete(this.prisma, userId);
    } else {
      await ensurePharmacyProfileComplete(this.prisma, userId);
    }

    const extras = await getProfileExtras(this.prisma, userId);
    const employerName =
      this.sanitizeText(
        extras.hospitalName ||
          extras.pharmacyName ||
          extras.businessName ||
          body.employerName ||
          body.facilityName,
      ) || 'Unknown Employer';
    const employerLocation =
      this.sanitizeText(
        body.location ||
          extras.locationAddress ||
          extras.location?.address ||
          extras.location ||
          extras.address,
      ) || null;

    const title = this.sanitizeText(body.title || body.task);
    const description = this.sanitizeText(body.description || body.summary);
    const requirements = this.sanitizeText(body.requirements ?? body.specifications);
    const availableSlots = Number(
      body.requiredMedics ?? body.availableSlots ?? body.medicsRequired ?? 0,
    );

    const payload: any = {
      title,
      description,
      department: this.textOrFallback(body.department, 'General'),
      specialization: this.textOrFallback(body.specialization || body.category, 'General'),
      jobType: this.textOrFallback(body.jobType, 'FULL_TIME'),
      scheduleType: this.textOrFallback(body.scheduleType, 'STANDARD'),
      shiftPattern: this.textOrFallback(body.shiftPattern, 'Long-term'),
      experienceLevel: this.textOrFallback(body.experienceLevel, 'Not specified'),
      responsibilities: this.textOrFallback(body.responsibilities, description || 'As assigned'),
      qualifications: this.textOrFallback(body.qualifications, 'Not specified'),
      requirements,
      benefits: this.textOrFallback(body.benefits, 'Not specified'),
      contactEmail: this.textOrFallback(body.contactEmail, 'not-provided@medilink.local'),
      contactPhone: this.textOrFallback(body.contactPhone, 'Not provided'),
      applicationDeadline: this.textOrFallback(body.applicationDeadline, ''),
      startDate: this.textOrFallback(body.startDate, ''),
      location: employerLocation || 'Not specified',
      requiredMedics: availableSlots,
      hours: Math.max(0, Number(body.hours || 0)),
      payType: this.sanitizeText(body.payType),
      payAmount: Number(body.payAmount || 0),
      status: 'OPEN',
      createdBy: userId,
      employerType: role === 'HOSPITAL_ADMIN' ? 'HOSPITAL' : 'PHARMACY',
      employerName,
      applications: [],
    };

    this.ensureJobFieldsComplete(payload);
    return this.db.job.create({ data: payload });
  }

  @Post(':id/apply')
  async apply(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can apply to jobs.');
    }

    const job = await this.db.job.findUnique({ where: { id } });
    if (!job) return { success: false };

    const userId = req.user?.userId;
    await ensureMedicProfileComplete(this.prisma, userId);

    const applications = Array.isArray(job.applications) ? job.applications : [];
    const exists = applications.some((item: any) => item?.medicId === userId);
    if (exists) {
      const existingApplication = applications.find((item: any) => item?.medicId === userId);
      return {
        success: true,
        alreadyApplied: true,
        application: existingApplication || null,
      };
    }

    const nextApplications = [
      ...applications,
      {
        medicId: userId,
        appliedAt: new Date().toISOString(),
        status: 'PENDING',
      },
    ];

    await this.db.job.update({
      where: { id },
      data: { applications: nextApplications },
    });

    return {
      success: true,
      application: nextApplications[nextApplications.length - 1],
    };
  }

  @Post(':id/unapply')
  async unapply(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can cancel job applications.');
    }

    const job = await this.db.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found.');

    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('Not allowed to cancel this application.');
    }

    const applications = Array.isArray(job.applications) ? job.applications : [];
    const existing = applications.find((item: any) => item?.medicId === userId);
    if (!existing) {
      return { success: true, notApplied: true };
    }

    const nextApplications = applications.filter((item: any) => item?.medicId !== userId);
    await this.db.job.update({
      where: { id },
      data: { applications: nextApplications },
    });

    if (job?.createdBy && job.createdBy !== userId) {
      const title = 'Job application cancelled';
      const message = `A medic cancelled their application for ${job?.title || 'a job'}.`;

      InMemoryStore.create('notifications', {
        userId: job.createdBy,
        title,
        message,
        type: 'JOB_APPLICATION_WITHDRAWN',
        relatedId: job.id,
        data: {
          jobId: job.id,
          medicId: userId,
          status: 'WITHDRAWN',
        },
        isRead: false,
        createdAt: new Date().toISOString(),
      });

      this.notificationsGateway.emitToUser(job.createdBy, {
        title,
        message,
        type: 'JOB_APPLICATION_WITHDRAWN',
        data: {
          jobId: job.id,
          medicId: userId,
          status: 'WITHDRAWN',
        },
      });
    }

    return { success: true, cancelled: true };
  }

  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const job = (await this.db.job.findUnique({ where: { id } })) as any;
    if (!job) throw new NotFoundException('Job not found.');

    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (job.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to edit this job.');
    }

    const nextTitle = this.sanitizeText(body.title ?? body.task ?? job.title);
    const nextDescription = this.sanitizeText(body.description ?? body.summary ?? job.description);
    const nextDepartment = this.textOrFallback(body.department, job.department || 'General');
    const nextSpecialization = this.textOrFallback(
      body.specialization ?? body.category,
      job.specialization || 'General',
    );
    const nextJobType = this.textOrFallback(body.jobType, job.jobType || 'FULL_TIME');
    const nextScheduleType = this.textOrFallback(body.scheduleType, job.scheduleType || 'STANDARD');
    const nextShiftPattern = this.textOrFallback(body.shiftPattern, job.shiftPattern || 'Long-term');
    const nextExperienceLevel = this.textOrFallback(
      body.experienceLevel,
      job.experienceLevel || 'Not specified',
    );
    const nextResponsibilities = this.textOrFallback(
      body.responsibilities,
      job.responsibilities || nextDescription || 'As assigned',
    );
    const nextQualifications = this.textOrFallback(
      body.qualifications,
      job.qualifications || 'Not specified',
    );
    const nextRequirements =
      this.sanitizeText(body.requirements ?? body.specifications ?? job.requirements);
    const nextBenefits = this.textOrFallback(body.benefits, job.benefits || 'Not specified');
    const nextContactEmail = this.textOrFallback(
      body.contactEmail,
      job.contactEmail || 'not-provided@medilink.local',
    );
    const nextContactPhone = this.textOrFallback(
      body.contactPhone,
      job.contactPhone || 'Not provided',
    );
    const nextApplicationDeadline = this.textOrFallback(
      body.applicationDeadline,
      job.applicationDeadline || '',
    );
    const nextStartDate = this.textOrFallback(body.startDate, job.startDate || '');
    const nextLocation = this.textOrFallback(body.location, job.location || 'Not specified');
    const nextRequiredMedics = Number(
      body.requiredMedics ?? body.availableSlots ?? body.medicsRequired ?? job.requiredMedics ?? 0,
    );
    const nextHours = Math.max(0, Number(body.hours ?? job.hours ?? 0));

    this.ensureJobFieldsComplete({
      title: nextTitle,
      description: nextDescription,
      requirements: nextRequirements,
      requiredMedics: nextRequiredMedics,
    });

    return this.db.job.update({
      where: { id },
      data: {
        title: nextTitle,
        description: nextDescription,
        department: nextDepartment,
        specialization: nextSpecialization,
        jobType: nextJobType,
        scheduleType: nextScheduleType,
        shiftPattern: nextShiftPattern,
        experienceLevel: nextExperienceLevel,
        responsibilities: nextResponsibilities,
        qualifications: nextQualifications,
        requirements: nextRequirements,
        benefits: nextBenefits,
        contactEmail: nextContactEmail,
        contactPhone: nextContactPhone,
        applicationDeadline: nextApplicationDeadline,
        startDate: nextStartDate,
        location: nextLocation,
        requiredMedics: nextRequiredMedics,
        hours: nextHours,
        payType: this.sanitizeText(body.payType ?? job.payType),
        payAmount: body.payAmount ?? job.payAmount,
        status: body.status ?? job.status,
      },
    });
  }

  @Put(':id/cancel')
  async cancel(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const job = (await this.db.job.findUnique({ where: { id } })) as any;
    if (!job) throw new NotFoundException('Job not found.');

    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (job.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to cancel this job.');
    }

    const cancelled = await this.db.job.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: body?.reason || 'Cancelled by employer admin',
        cancelledAt: new Date(),
        cancelledBy: userId,
      },
    });

    await this.notifyAppliedMedicsOfCancellation(cancelled as any);
    return cancelled;
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const job = (await this.db.job.findUnique({ where: { id } })) as any;
    if (!job) throw new NotFoundException('Job not found.');

    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (job.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to delete this job.');
    }

    await this.db.job.delete({ where: { id } });
    return { success: true };
  }

  private async notifyAppliedMedicsOfCancellation(job: any) {
    const applications = Array.isArray(job?.applications) ? job.applications : [];
    const medicIds: string[] = Array.from(
      new Set<string>(
        applications
          .map((item: any) => String(item?.medicId || '').trim())
          .filter((id: string) => id.length > 0),
      ),
    );
    if (!medicIds.length) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: medicIds } },
      select: { id: true, email: true, fullName: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));

    await Promise.allSettled(
      medicIds.map(async (medicId) => {
        const user = byId.get(medicId);
        const title = 'Job Cancelled';
        const message = `${job?.title || 'A job'} at ${
          job?.employerName || 'the facility'
        } was cancelled.`;

        InMemoryStore.create('notifications', {
          userId: medicId,
          title,
          message,
          type: 'JOB_CANCELLED',
          relatedId: job?.id,
          data: { jobId: job?.id, status: 'CANCELLED' },
          isRead: false,
          createdAt: new Date().toISOString(),
        });

        this.notificationsGateway.emitToUser(medicId, {
          title,
          message,
          type: 'JOB_CANCELLED',
          data: { jobId: job?.id, status: 'CANCELLED' },
        });

        const extras = await getProfileExtras(this.prisma, medicId);
        const tokens = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
        if (tokens.length) {
          await this.push.sendToTokens(tokens, {
            title,
            body: message,
            data: { jobId: String(job?.id || ''), type: 'JOB_CANCELLED' },
          });
        }

        if (user?.email) {
          const html = this.emails.buildBrandedHtml({
            title,
            body: `
              <p>Hello ${user.fullName || 'Medic'},</p>
              <p>${message}</p>
              <p>Job: <strong>${job?.title || 'N/A'}</strong></p>
              <p>Status: <strong>CANCELLED</strong></p>
            `,
          });
          await this.emails.sendTransactional({
            to: user.email,
            subject: `Job cancelled: ${job?.title || 'Job'}`,
            html,
            text: `${message} Job: ${job?.title || 'N/A'}.`,
            tags: { type: 'job_cancelled' },
            metadata: { refId: String(job?.id || '') },
          });
        }
      }),
    );
  }
}
