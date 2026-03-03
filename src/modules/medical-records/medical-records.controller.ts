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
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/database/prisma.service';

@Controller('medical-records')
@UseGuards(AuthGuard('jwt'))
export class MedicalRecordsController {
  constructor(private prisma: PrismaService) {}

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
        // Medics can query a patient's timeline and their own authored records.
        where.patientId = patientId;
      } else {
        where.medicId = currentUserId;
      }
    } else if (role !== 'SUPER_ADMIN' && role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Not allowed to access medical records.');
    }

    return this.prisma.medicalRecord.findMany({
      where,
      include: {
        medic: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
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
    if (role === 'MEDIC' && record.medicId !== currentUserId) {
      throw new ForbiddenException('You cannot view this record.');
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
}
