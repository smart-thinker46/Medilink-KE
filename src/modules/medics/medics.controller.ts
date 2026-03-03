import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Post,
  Req,
  Body,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/database/prisma.service';
import { InMemoryStore } from 'src/common/in-memory.store';
import {
  getProfileExtras,
  getProfileExtrasMap,
  mergeProfileExtras,
} from 'src/common/profile-extras';
import { ensureHospitalProfileComplete } from 'src/common/profile-validation';

@Controller('medics')
@UseGuards(AuthGuard('jwt'))
export class MedicsController {
  constructor(private prisma: PrismaService) {}

  private normalizeRole(role: unknown) {
    return String(role || '').toUpperCase();
  }

  private normalizeMoney(value: unknown) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? amount : 0;
  }

  private clampPercent(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  }

  private hasMedicalRecordGrant(extras: any, medicId?: string | null) {
    if (!medicId) return false;
    const grants = Array.isArray(extras?.medicalRecordAccessGrants)
      ? extras.medicalRecordAccessGrants
      : [];
    return grants.some(
      (grant: any) =>
        String(grant?.medicId || '') === String(medicId) &&
        grant?.active !== false,
    );
  }

  private async resolveMedicScope(req: any, requestedMedicId?: string) {
    const role = this.normalizeRole(req.user?.role);
    const actorId = String(req.user?.userId || '').trim();
    const scopedMedicId = String(requestedMedicId || '').trim();

    if (role === 'MEDIC') {
      return actorId;
    }

    if (role === 'SUPER_ADMIN') {
      if (!scopedMedicId) return actorId;
      const medic = await this.prisma.user.findUnique({
        where: { id: scopedMedicId },
        select: { id: true, role: true },
      });
      if (!medic || this.normalizeRole(medic.role) !== 'MEDIC') {
        throw new BadRequestException('Invalid medicId scope.');
      }
      return medic.id;
    }

    return actorId;
  }

  private async assertCanManagePatient(req: any, patientId: string) {
    const role = this.normalizeRole(req.user?.role);
    const actorId = req.user?.userId;

    if (!patientId) {
      throw new BadRequestException('patientId is required.');
    }

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, role: true, fullName: true },
    });
    if (!patient || this.normalizeRole(patient.role) !== 'PATIENT') {
      throw new BadRequestException('Invalid patient account.');
    }

    if (role === 'SUPER_ADMIN' || role === 'HOSPITAL_ADMIN') {
      return patient;
    }

    if (role !== 'MEDIC') {
      throw new ForbiddenException('Not allowed to manage patient health status.');
    }

    const extras = await getProfileExtras(this.prisma, patientId);
    if (!this.hasMedicalRecordGrant(extras, actorId)) {
      throw new ForbiddenException(
        'Patient consent is required before viewing or updating health records.',
      );
    }

    return patient;
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('location') location?: string,
    @Query('category') category?: string,
    @Query('specialization') specialization?: string,
    @Query('experienceMin') experienceMin?: string,
    @Query('experienceMax') experienceMax?: string,
    @Query('availabilityDay') availabilityDay?: string,
  ) {
    const medics = await this.prisma.user.findMany({
      where: {
        role: 'MEDIC',
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { medicProfile: true },
      take: 50,
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, medics.map((m) => m.id));
    let list = medics.map((medic) => {
      const extras = extrasMap.get(medic.id) || {};
      const locationObject =
        extras.location && typeof extras.location === 'object' ? extras.location : null;
      const location =
        extras.locationAddress ||
        (typeof extras.location === 'string'
          ? extras.location
          : locationObject?.address || null);
      const locationLat =
        locationObject?.lat !== undefined && locationObject?.lat !== null
          ? Number(locationObject.lat)
          : null;
      const locationLng =
        locationObject?.lng !== undefined && locationObject?.lng !== null
          ? Number(locationObject.lng)
          : null;
      const availabilityDays = Array.isArray(extras.availableDays)
        ? extras.availableDays
        : typeof extras.availableDays === 'string'
          ? extras.availableDays
              .split(',')
              .map((value: string) => value.trim())
              .filter(Boolean)
          : Array.isArray(extras.preferredShiftTypes)
            ? extras.preferredShiftTypes
            : [];
      return {
        id: medic.id,
        name: medic.fullName,
        firstName: medic.fullName?.split(' ')[0],
        lastName: medic.fullName?.split(' ').slice(1).join(' '),
        email: medic.email,
        phone: medic.phone || extras.phone || null,
        specialization: medic.medicProfile?.specialization || extras.specialization,
        experienceYears: medic.medicProfile?.experienceYears || extras.experienceYears,
        category: extras.category || extras.services || extras.specialty,
        location,
        locationAddress: location,
        locationLat,
        locationLng,
        locationCoordinates:
          locationLat !== null && locationLng !== null
            ? { lat: locationLat, lng: locationLng }
            : null,
        availabilityDays,
        cv: extras.cv || null,
        rating: 4.7,
      };
    });

    if (search) {
      const value = search.toLowerCase();
      list = list.filter((medic) => {
        const availabilityText = Array.isArray(medic.availabilityDays)
          ? medic.availabilityDays.join(' ')
          : '';
        return (
          String(medic.name || '').toLowerCase().includes(value) ||
          String(medic.email || '').toLowerCase().includes(value) ||
          String(medic.specialization || '').toLowerCase().includes(value) ||
          String(medic.location || '').toLowerCase().includes(value) ||
          String(availabilityText).toLowerCase().includes(value)
        );
      });
    }

    if (location) {
      const value = location.toLowerCase();
      list = list.filter((medic) =>
        String(medic.location || '').toLowerCase().includes(value),
      );
    }
    if (category) {
      const value = category.toLowerCase();
      list = list.filter((medic) =>
        String(medic.category || '').toLowerCase().includes(value),
      );
    }
    if (specialization) {
      const value = specialization.toLowerCase();
      list = list.filter((medic) =>
        String(medic.specialization || '').toLowerCase().includes(value),
      );
    }
    if (experienceMin || experienceMax) {
      const min = experienceMin ? Number(experienceMin) : 0;
      const max = experienceMax ? Number(experienceMax) : 100;
      list = list.filter((medic) => {
        const years = Number(medic.experienceYears || 0);
        return years >= min && years <= max;
      });
    }
    if (availabilityDay) {
      const value = availabilityDay.toLowerCase();
      list = list.filter((medic) =>
        (Array.isArray(medic.availabilityDays) ? medic.availabilityDays : [])
          .some((entry) => String(entry || '').toLowerCase().includes(value)),
      );
    }

    return list;
  }

  @Get('hires')
  async myHires(@Req() req: any, @Query('medicId') requestedMedicId?: string) {
    const medicId = await this.resolveMedicScope(req, requestedMedicId);
    const hires = InMemoryStore.list('medicHires') as any[];
    return hires.filter((hire) => hire.medicId === medicId);
  }

  @Get('analytics/me')
  async myAnalytics(@Req() req: any, @Query('medicId') requestedMedicId?: string) {
    const role = this.normalizeRole(req.user?.role);
    const medicId = await this.resolveMedicScope(req, requestedMedicId);
    if (role !== 'MEDIC' && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only medics can view this analytics.');
    }

    const records = await this.prisma.medicalRecord.findMany({
      where: { medicId },
      select: { id: true, type: true, patientId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const patientIds = Array.from(
      new Set(records.map((item) => item.patientId).filter(Boolean)),
    );
    const extrasMap = await getProfileExtrasMap(this.prisma, patientIds);

    let recoveredPatients = 0;
    let underTreatment = 0;
    let criticalPatients = 0;
    let stablePatients = 0;
    const underTreatmentPatientIds: string[] = [];

    patientIds.forEach((patientId) => {
      const extras = extrasMap.get(patientId) || {};
      const rawScore = Number(extras?.healthScore);
      const healthScore = Number.isFinite(rawScore) ? rawScore : 60;
      const recoveryStatus = this.normalizeRole(extras?.recoveryStatus);
      const isRecovered = recoveryStatus === 'RECOVERED' || healthScore >= 100;
      if (isRecovered) {
        recoveredPatients += 1;
      } else {
        underTreatment += 1;
        underTreatmentPatientIds.push(patientId);
      }
      if (healthScore < 40) {
        criticalPatients += 1;
      } else {
        stablePatients += 1;
      }
    });

    const payments = (InMemoryStore.list('payments') as any[]) || [];
    const medicPayments = payments.filter((item: any) => item?.recipientId === medicId);
    const paidPayments = medicPayments.filter(
      (item: any) => this.normalizeRole(item?.status) === 'PAID',
    );
    const pendingPayments = medicPayments.filter(
      (item: any) => this.normalizeRole(item?.status) === 'PENDING',
    );
    const pendingFromUnderTreatment = pendingPayments.filter((item: any) =>
      underTreatmentPatientIds.includes(item?.userId),
    );

    const moneyMade = paidPayments.reduce(
      (sum: number, item: any) => sum + this.normalizeMoney(item?.amount),
      0,
    );
    const pendingMoney = pendingPayments.reduce(
      (sum: number, item: any) => sum + this.normalizeMoney(item?.amount),
      0,
    );
    const pendingFromTreatingPatients = pendingFromUnderTreatment.reduce(
      (sum: number, item: any) => sum + this.normalizeMoney(item?.amount),
      0,
    );
    const failedPayments = medicPayments.filter(
      (item: any) => this.normalizeRole(item?.status) === 'FAILED',
    );

    const prescriptionsIssued = records.filter(
      (item) => String(item.type || '').toLowerCase() === 'prescription',
    ).length;
    const clinicalUpdates = records.filter(
      (item) => String(item.type || '').toLowerCase() === 'clinical_update',
    ).length;
    const conditionsUpdated = records.filter(
      (item) => String(item.type || '').toLowerCase() === 'condition',
    ).length;

    return {
      totals: {
        patientsServed: patientIds.length,
        underTreatment,
        recoveredPatients,
        criticalPatients,
        stablePatients,
        totalRecords: records.length,
        prescriptionsIssued,
        clinicalUpdates,
        conditionsUpdated,
        moneyMade,
        pendingMoney,
        pendingFromTreatingPatients,
      },
      wallet: {
        currency: 'KES',
        availableBalance: Number(moneyMade.toFixed(2)),
        pendingBalance: Number(pendingMoney.toFixed(2)),
        totalReceived: Number(moneyMade.toFixed(2)),
        totalTransactions: medicPayments.length,
        paidTransactions: paidPayments.length,
        pendingTransactions: pendingPayments.length,
        failedTransactions: failedPayments.length,
      },
      charts: {
        patientStatus: {
          recovered: recoveredPatients,
          underTreatment,
        },
        patientRisk: {
          critical: criticalPatients,
          stable: stablePatients,
        },
        finance: {
          paid: moneyMade,
          pending: pendingMoney,
        },
        records: {
          prescriptions: prescriptionsIssued,
          clinicalUpdates,
          conditionUpdates: conditionsUpdated,
        },
      },
    };
  }

  @Get('patients/:patientId/health-status')
  async getPatientHealthStatus(@Req() req: any, @Param('patientId') patientId: string) {
    const patient = await this.assertCanManagePatient(req, patientId);
    const extras = await getProfileExtras(this.prisma, patient.id);
    const rawScore = Number(extras?.healthScore);
    const defaultScore = Number.isFinite(rawScore) ? rawScore : 60;
    const recoveryStatus = this.normalizeRole(extras?.recoveryStatus) || 'UNDER_TREATMENT';
    const score = recoveryStatus === 'RECOVERED' ? 100 : defaultScore;
    return {
      patientId: patient.id,
      patientName: patient.fullName || 'Patient',
      healthScore: score,
      recoveryStatus: recoveryStatus === 'RECOVERED' ? 'RECOVERED' : 'UNDER_TREATMENT',
      recoveredAt: extras?.recoveredAt || null,
      updatedAt: extras?.healthStatusUpdatedAt || null,
      updatedBy: extras?.healthStatusUpdatedBy || null,
      updatedByRole: extras?.healthStatusUpdatedByRole || null,
    };
  }

  @Post('patients/:patientId/health-status')
  async updatePatientHealthStatus(
    @Req() req: any,
    @Param('patientId') patientId: string,
    @Body() body: any,
  ) {
    const role = this.normalizeRole(req.user?.role);
    const actorId = req.user?.userId;
    const scopedMedicId =
      role === 'SUPER_ADMIN' || role === 'HOSPITAL_ADMIN'
        ? String(body?.medicId || body?.medic_id || actorId || '').trim()
        : String(actorId || '').trim();
    const patient = await this.assertCanManagePatient(req, patientId);

    const requestedScore = this.clampPercent(body?.healthScore);
    const requestedRecovered = Boolean(body?.recovered);
    const requestedStatus = this.normalizeRole(body?.recoveryStatus || body?.status);

    let finalStatus: 'RECOVERED' | 'UNDER_TREATMENT' = 'UNDER_TREATMENT';
    if (requestedRecovered || requestedStatus === 'RECOVERED' || requestedScore === 100) {
      finalStatus = 'RECOVERED';
    }
    const finalScore =
      finalStatus === 'RECOVERED'
        ? 100
        : requestedScore !== null
          ? requestedScore
          : 60;

    const nowIso = new Date().toISOString();
    await mergeProfileExtras(this.prisma, patient.id, {
      healthScore: finalScore,
      recoveryStatus: finalStatus,
      recoveredAt: finalStatus === 'RECOVERED' ? nowIso : null,
      healthStatusUpdatedAt: nowIso,
      healthStatusUpdatedBy: actorId,
      healthStatusUpdatedByRole: role,
    });

    const note = body?.note
      ? String(body.note).trim()
      : finalStatus === 'RECOVERED'
        ? 'Patient marked as recovered.'
        : `Health score updated to ${finalScore}%.`;
    const record = await this.prisma.medicalRecord.create({
      data: {
        patientId: patient.id,
        medicId: scopedMedicId || actorId || body?.medic_id,
        type: 'condition',
        condition: finalStatus === 'RECOVERED' ? 'Recovered' : 'Under treatment',
        notes: note,
        attachments: [
          {
            kind: 'health_status',
            healthScore: finalScore,
            recoveryStatus: finalStatus,
            updatedBy: actorId,
            updatedByRole: role,
            updatedAt: nowIso,
          },
        ],
      } as any,
    });

    return {
      success: true,
      patientId: patient.id,
      patientName: patient.fullName || 'Patient',
      healthScore: finalScore,
      recoveryStatus: finalStatus,
      recordId: record.id,
    };
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    const medic = await this.prisma.user.findUnique({
      where: { id },
      include: { medicProfile: true },
    });
    if (!medic) return null;
    const extras = await getProfileExtras(this.prisma, medic.id);
    const workingDays = Array.isArray(extras?.availableDays)
      ? extras.availableDays
      : typeof extras?.availableDays === 'string'
        ? extras.availableDays
            .split(',')
            .map((value: string) => value.trim())
            .filter(Boolean)
        : Array.isArray(extras?.workingDays)
          ? extras.workingDays
          : typeof extras?.workingDays === 'string'
            ? extras.workingDays
                .split(',')
                .map((value: string) => value.trim())
                .filter(Boolean)
            : Array.isArray(extras?.preferredShiftTypes)
              ? extras.preferredShiftTypes
              : [];
    const consultationFee =
      medic.medicProfile?.consultationFee !== null &&
      medic.medicProfile?.consultationFee !== undefined
        ? Number(medic.medicProfile.consultationFee)
        : extras?.consultationFee !== null && extras?.consultationFee !== undefined
          ? Number(extras.consultationFee)
          : null;
    const locationObject =
      extras?.location && typeof extras.location === 'object' ? extras.location : null;
    const locationAddress =
      extras?.locationAddress ||
      locationObject?.address ||
      (typeof extras?.location === 'string' ? extras.location : null);
    return {
      id: medic.id,
      name: medic.fullName,
      email: medic.email,
      phone: medic.phone || null,
      specialization: medic.medicProfile?.specialization || extras?.specialization || null,
      experienceYears:
        medic.medicProfile?.experienceYears ??
        (extras?.experienceYears ? Number(extras.experienceYears) : null),
      professionalType: extras?.professionalType || null,
      licenseNumber: medic.medicProfile?.licenseNumber || extras?.licenseNumber || null,
      licenseUrl: extras?.licenseUrl || extras?.license || null,
      consultationFee,
      consultationPrice: consultationFee,
      workingDays,
      availabilityDays: workingDays,
      location: {
        address: locationAddress || null,
        lat:
          locationObject?.lat !== undefined && locationObject?.lat !== null
            ? Number(locationObject.lat)
            : null,
        lng:
          locationObject?.lng !== undefined && locationObject?.lng !== null
            ? Number(locationObject.lng)
            : null,
      },
      cv: extras?.cv || null,
      rating: 4.7,
    };
  }

  @Post(':id/approve')
  async approve(@Req() req: any, @Param('id') id: string) {
    await ensureHospitalProfileComplete(this.prisma, req.user?.userId);
    const record = InMemoryStore.create('medicApprovals', {
      medicId: id,
      hospitalAdminId: req.user?.userId,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    });
    return { success: true, record };
  }

  @Post(':id/hire')
  async hire(@Req() req: any, @Param('id') id: string) {
    await ensureHospitalProfileComplete(this.prisma, req.user?.userId);
    const record = InMemoryStore.create('medicHires', {
      medicId: id,
      hospitalAdminId: req.user?.userId,
      status: 'HIRED',
      createdAt: new Date().toISOString(),
    });
    return { success: true, record };
  }
}
