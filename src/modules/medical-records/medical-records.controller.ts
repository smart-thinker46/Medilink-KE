import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Query,
  Param,
  Req,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { randomUUID } from 'crypto';
import { InMemoryStore } from 'src/common/in-memory.store';
import {
  getProfileExtras,
  getProfileExtrasMap,
  mergeProfileExtras,
} from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationsGateway } from 'src/modules/notifications/notifications.gateway';

@Controller('medical-records')
@UseGuards(AuthGuard('jwt'))
export class MedicalRecordsController {
  constructor(
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
  ) {}

  private parseAccessRequests(extras: any): any[] {
    return Array.isArray(extras?.medicalRecordAccessRequests)
      ? extras.medicalRecordAccessRequests
      : [];
  }

  private parseAccessGrants(extras: any): any[] {
    return Array.isArray(extras?.medicalRecordAccessGrants)
      ? extras.medicalRecordAccessGrants
      : [];
  }

  private hasActiveGrant(extras: any, medicId?: string | null) {
    if (!medicId) return false;
    const grants = this.parseAccessGrants(extras);
    return grants.some(
      (grant) =>
        String(grant?.medicId || '') === String(medicId) &&
        grant?.active !== false,
    );
  }

  private async ensureMedicAccess(patientId?: string, medicId?: string) {
    if (!patientId || !medicId) {
      throw new ForbiddenException('Patient consent is required.');
    }
    const extras = await getProfileExtras(this.prisma, patientId);
    if (!this.hasActiveGrant(extras, medicId)) {
      throw new ForbiddenException(
        'Patient consent is required before accessing medical records. Request access first.',
      );
    }
  }

  private async notifyUser(
    userId: string,
    title: string,
    message: string,
    type: string,
    relatedId?: string | null,
    data?: Record<string, any> | null,
  ) {
    if (!userId) return;
    InMemoryStore.create('notifications', {
      userId,
      title,
      message,
      type,
      relatedId: relatedId || null,
      data: data || null,
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    this.notificationsGateway.emitToUser(userId, {
      title,
      message,
      type,
      data: data || null,
    });
  }

  @Get()
  async list(
    @Req() req: any,
    @Query('patient_id') patientId?: string,
    @Query('medic_id') medicId?: string,
    @Query('type') type?: string,
  ) {
    const role = String(req.user?.role || '').toUpperCase();
    const currentUserId = req.user?.userId;
    const where: any = {
      ...(patientId ? { patientId } : {}),
      ...(medicId ? { medicId } : {}),
      ...(type ? { type: String(type).toLowerCase() } : {}),
    };

    if (role === 'PATIENT') {
      where.patientId = currentUserId;
    } else if (role === 'MEDIC') {
      if (patientId) {
        await this.ensureMedicAccess(patientId, currentUserId);
        where.patientId = patientId;
      } else {
        where.medicId = currentUserId;
      }
    } else if (role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Not allowed to access medical records.');
    }

    const records = await this.prisma.medicalRecord.findMany({
      where,
      include: {
        medic: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (role === 'MEDIC' && !patientId) {
      const patientIds = Array.from(
        new Set(
          records
            .map((item) => String(item?.patientId || '').trim())
            .filter(Boolean),
        ),
      );
      const extrasMap = await getProfileExtrasMap(this.prisma, patientIds);
      return records.filter((record) =>
        this.hasActiveGrant(extrasMap.get(record.patientId) || {}, currentUserId),
      );
    }

    return records;
  }

  @Get(':id')
  async getById(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    const currentUserId = req.user?.userId;
    const record = await this.prisma.medicalRecord.findUnique({
      where: { id },
      include: {
        medic: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!record) return null;
    if (role === 'PATIENT' && record.patientId !== currentUserId) {
      throw new ForbiddenException('You cannot view this record.');
    }
    if (role === 'MEDIC') {
      await this.ensureMedicAccess(record.patientId, currentUserId);
    }
    if (!['PATIENT', 'MEDIC', 'SUPER_ADMIN', 'HOSPITAL_ADMIN'].includes(role)) {
      throw new ForbiddenException('Not allowed to access medical records.');
    }
    return record;
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const medicId = req.user?.userId;
    if (role !== 'MEDIC' && role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only medics can create patient records.');
    }
    if (!body.patient_id) {
      throw new BadRequestException('patient_id is required.');
    }
    if (role === 'MEDIC') {
      await this.ensureMedicAccess(body.patient_id, req.user?.userId);
    }

    return this.prisma.medicalRecord.create({
      data: {
        patientId: body.patient_id,
        medicId: body.medic_id || medicId,
        notes: body.notes,
        condition: body.condition,
        type: String(body.type || 'note').toLowerCase(),
        attachments: body.attachments || undefined,
      } as any,
    });
  }

  @Post('condition')
  async updateCondition(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC' && role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only medics can update patient condition.');
    }
    if (!body.patient_id) {
      throw new BadRequestException('patient_id is required.');
    }
    if (role === 'MEDIC') {
      await this.ensureMedicAccess(body.patient_id, req.user?.userId);
    }

    return this.prisma.medicalRecord.create({
      data: {
        patientId: body.patient_id,
        medicId: body.medic_id || req.user?.userId,
        condition: body.condition,
        notes: body.notes || body.condition,
        type: 'condition',
        attachments: body.attachments || undefined,
      } as any,
    });
  }

  @Post('prescription')
  async createPrescription(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC' && role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only medics can prescribe for patients.');
    }
    if (!body.patient_id) {
      throw new BadRequestException('patient_id is required.');
    }
    if (role === 'MEDIC') {
      await this.ensureMedicAccess(body.patient_id, req.user?.userId);
    }

    const medications = Array.isArray(body.medications)
      ? body.medications
      : String(body.medications || '')
          .split(',')
          .map((item: string) => item.trim())
          .filter(Boolean);
    const prescriptionText = body.prescription || body.notes || medications.join(', ');

    const attachmentArray = Array.isArray(body.attachments) ? body.attachments : [];
    const enrichedAttachments = [
      ...attachmentArray,
      {
        kind: 'prescription_meta',
        medications,
        dosage: body.dosage || null,
        frequency: body.frequency || null,
        duration: body.duration || null,
      },
    ];

    return this.prisma.medicalRecord.create({
      data: {
        patientId: body.patient_id,
        medicId: body.medic_id || req.user?.userId,
        notes: prescriptionText,
        type: 'prescription',
        attachments: enrichedAttachments,
      } as any,
    });
  }

  @Post('clinical-update')
  async createClinicalUpdate(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC' && role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only medics can create clinical updates.');
    }
    if (!body.patient_id) {
      throw new BadRequestException('patient_id is required.');
    }
    if (role === 'MEDIC') {
      await this.ensureMedicAccess(body.patient_id, req.user?.userId);
    }

    const diagnosis = String(body.diagnosis || '').trim();
    const progress = String(body.progress || body.progressNotes || '').trim();
    const healthIssues = String(body.healthIssues || body.issues || '').trim();
    const treatmentPlan = String(body.treatmentPlan || '').trim();
    const medicines = Array.isArray(body.prescribedMedicines)
      ? body.prescribedMedicines
      : String(body.prescribedMedicines || '')
          .split(',')
          .map((item: string) => item.trim())
          .filter(Boolean);

    const compiledNotes = [
      progress ? `Progress: ${progress}` : null,
      diagnosis ? `Diagnosis: ${diagnosis}` : null,
      healthIssues ? `Health Issues: ${healthIssues}` : null,
      treatmentPlan ? `Treatment Plan: ${treatmentPlan}` : null,
      medicines.length ? `Prescribed medicines: ${medicines.join(', ')}` : null,
      body.notes ? `Additional Notes: ${String(body.notes).trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const attachmentArray = Array.isArray(body.attachments) ? body.attachments : [];
    const enrichedAttachments = [
      ...attachmentArray,
      {
        kind: 'clinical_meta',
        diagnosis,
        progress,
        healthIssues,
        treatmentPlan,
        prescribedMedicines: medicines,
      },
    ];

    return this.prisma.medicalRecord.create({
      data: {
        patientId: body.patient_id,
        medicId: body.medic_id || req.user?.userId,
        condition: diagnosis || healthIssues || undefined,
        notes: compiledNotes || body.notes || 'Clinical update',
        type: 'clinical_update',
        attachments: enrichedAttachments,
      } as any,
    });
  }

  @Post('access/request')
  async requestAccess(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const medicId = req.user?.userId;
    const patientId = String(body?.patient_id || '').trim();
    const note = String(body?.note || '').trim();

    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can request record access.');
    }
    if (!patientId) {
      throw new BadRequestException('patient_id is required.');
    }
    if (!medicId) {
      throw new BadRequestException('Medic account is required.');
    }

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!patient) {
      throw new NotFoundException('Patient not found.');
    }

    const extras = await getProfileExtras(this.prisma, patientId);
    const requests = this.parseAccessRequests(extras);
    const grants = this.parseAccessGrants(extras);

    if (this.hasActiveGrant(extras, medicId)) {
      return { success: true, status: 'GRANTED' };
    }

    const existingPending = requests.find(
      (item) =>
        String(item?.medicId || '') === String(medicId) &&
        String(item?.status || '').toUpperCase() === 'PENDING',
    );
    if (existingPending) {
      return {
        success: true,
        status: 'PENDING',
        request: existingPending,
      };
    }

    const request = {
      id: randomUUID(),
      patientId,
      medicId,
      note: note || null,
      status: 'PENDING',
      requestedAt: new Date().toISOString(),
      respondedAt: null,
    };

    const nextRequests = [request, ...requests].slice(0, 200);
    await mergeProfileExtras(this.prisma, patientId, {
      medicalRecordAccessRequests: nextRequests,
      medicalRecordAccessGrants: grants,
    });

    const medic = await this.prisma.user.findUnique({
      where: { id: medicId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    const medicName = medic?.fullName || medic?.email || 'A medic';

    await this.notifyUser(
      patientId,
      'Medical record access request',
      `${medicName} requested access to your medical records.`,
      'MEDICAL_RECORD_ACCESS_REQUEST',
      request.id,
      {
        requestId: request.id,
        medicId,
        medicName,
        note: note || null,
      },
    );

    return {
      success: true,
      status: 'PENDING',
      request,
    };
  }

  @Get('access/requests')
  async listAccessRequests(
    @Req() req: any,
    @Query('patient_id') patientId?: string,
    @Query('status') status?: string,
  ) {
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    const statusFilter = String(status || '').trim().toUpperCase();

    if (role === 'PATIENT') {
      const extras = await getProfileExtras(this.prisma, userId);
      const requests = this.parseAccessRequests(extras);
      const filtered = statusFilter
        ? requests.filter(
            (item) => String(item?.status || '').toUpperCase() === statusFilter,
          )
        : requests;

      const medicIds = Array.from(
        new Set(
          filtered
            .map((item) => String(item?.medicId || '').trim())
            .filter(Boolean),
        ),
      );
      const medics = medicIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: medicIds } },
            select: { id: true, fullName: true, email: true, role: true },
          })
        : [];
      const medicMap = new Map(medics.map((medic) => [medic.id, medic]));

      return filtered.map((item) => ({
        ...item,
        medic: medicMap.get(String(item?.medicId || '')) || null,
      }));
    }

    if (role === 'MEDIC') {
      const targetPatientId = String(patientId || '').trim();
      if (!targetPatientId) {
        throw new BadRequestException('patient_id is required.');
      }
      const extras = await getProfileExtras(this.prisma, targetPatientId);
      const requests = this.parseAccessRequests(extras).filter(
        (item) => String(item?.medicId || '') === String(userId),
      );
      return statusFilter
        ? requests.filter(
            (item) => String(item?.status || '').toUpperCase() === statusFilter,
          )
        : requests;
    }

    throw new ForbiddenException('Not allowed to view access requests.');
  }

  @Post('access/requests/:id/respond')
  async respondAccessRequest(
    @Req() req: any,
    @Param('id') requestId: string,
    @Body() body: any,
  ) {
    const role = String(req.user?.role || '').toUpperCase();
    const patientId = req.user?.userId;
    if (role !== 'PATIENT') {
      throw new ForbiddenException('Only patients can respond to access requests.');
    }

    const accept = Boolean(body?.accept);
    const extras = await getProfileExtras(this.prisma, patientId);
    const requests = this.parseAccessRequests(extras);
    const grants = this.parseAccessGrants(extras);
    const requestIndex = requests.findIndex(
      (item) => String(item?.id || '') === String(requestId || ''),
    );
    if (requestIndex === -1) {
      throw new NotFoundException('Access request not found.');
    }

    const request = requests[requestIndex];
    const currentStatus = String(request?.status || '').toUpperCase();
    if (currentStatus !== 'PENDING') {
      return {
        success: true,
        request,
        granted: this.hasActiveGrant(extras, request?.medicId),
      };
    }

    const nextRequest = {
      ...request,
      status: accept ? 'ACCEPTED' : 'REJECTED',
      respondedAt: new Date().toISOString(),
    };
    const nextRequests = [...requests];
    nextRequests[requestIndex] = nextRequest;

    let nextGrants = [...grants];
    if (accept) {
      const grantIndex = nextGrants.findIndex(
        (item) => String(item?.medicId || '') === String(request?.medicId || ''),
      );
      const nextGrant = {
        medicId: request?.medicId,
        patientId,
        grantedAt: new Date().toISOString(),
        grantedBy: patientId,
        active: true,
      };
      if (grantIndex >= 0) {
        nextGrants[grantIndex] = { ...nextGrants[grantIndex], ...nextGrant };
      } else {
        nextGrants = [nextGrant, ...nextGrants];
      }
    }

    await mergeProfileExtras(this.prisma, patientId, {
      medicalRecordAccessRequests: nextRequests,
      medicalRecordAccessGrants: nextGrants,
    });

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { fullName: true, email: true },
    });
    const patientName = patient?.fullName || patient?.email || 'Patient';
    const message = accept
      ? `${patientName} approved your request to access medical records.`
      : `${patientName} declined your request to access medical records.`;
    await this.notifyUser(
      String(request?.medicId || ''),
      accept ? 'Medical record access approved' : 'Medical record access declined',
      message,
      accept
        ? 'MEDICAL_RECORD_ACCESS_APPROVED'
        : 'MEDICAL_RECORD_ACCESS_DECLINED',
      String(request?.id || ''),
      {
        requestId: request?.id,
        patientId,
        accepted: accept,
      },
    );

    return {
      success: true,
      request: nextRequest,
      granted: accept,
    };
  }

  @Get('access/status')
  async getAccessStatus(@Req() req: any, @Query('patient_id') patientId?: string) {
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    const targetPatientId = String(patientId || '').trim();
    if (!targetPatientId) {
      throw new BadRequestException('patient_id is required.');
    }

    if (role === 'SUPER_ADMIN' || role === 'HOSPITAL_ADMIN') {
      return {
        granted: true,
        pending: false,
        request: null,
      };
    }

    if (role === 'MEDIC') {
      const extras = await getProfileExtras(this.prisma, targetPatientId);
      const requests = this.parseAccessRequests(extras).filter(
        (item) => String(item?.medicId || '') === String(userId),
      );
      const latestRequest =
        requests.sort(
          (a, b) =>
            new Date(b?.requestedAt || 0).getTime() -
            new Date(a?.requestedAt || 0).getTime(),
        )[0] || null;
      const granted = this.hasActiveGrant(extras, userId);
      return {
        granted,
        pending:
          !granted &&
          String(latestRequest?.status || '').toUpperCase() === 'PENDING',
        request: latestRequest,
      };
    }

    if (role === 'PATIENT' && String(userId) === targetPatientId) {
      const extras = await getProfileExtras(this.prisma, targetPatientId);
      return {
        requests: this.parseAccessRequests(extras),
        grants: this.parseAccessGrants(extras),
      };
    }

    throw new ForbiddenException('Not allowed to access this status.');
  }
}
