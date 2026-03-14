import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Req,
  Param,
  Query,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/database/prisma.service';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtras, getProfileExtrasMap, mergeProfileExtras } from 'src/common/profile-extras';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { Prisma, UserRole } from '@prisma/client';
import {
  ALLOWED_PASSWORD_INTERVAL_DAYS,
  computePasswordExpiryDate,
  getPasswordDaysRemaining,
  isPasswordExpired,
  normalizePasswordIntervalDays,
} from 'src/common/security/password-policy';

@Controller('users')
@UseGuards(AuthGuard('jwt'))
export class UsersController {
  constructor(private prisma: PrismaService, private notificationsGateway: NotificationsGateway) {}

  private normalizeRole(role: unknown) {
    return String(role || '').trim().toUpperCase();
  }

  private toNum(value: unknown, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private parseMedicationList(value: unknown) {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseTimeList(value: unknown) {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
    return String(value || '')
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private toFiniteOrNull(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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

  private normalizeGeoLocation(rawLocation: unknown, fallbackAddress?: string | null) {
    if (!rawLocation || typeof rawLocation !== 'object') {
      return null;
    }
    const source = rawLocation as Record<string, any>;
    const latitude = this.toFiniteOrNull(source.latitude ?? source.lat);
    const longitude = this.toFiniteOrNull(source.longitude ?? source.lng);
    if (latitude === null || longitude === null) return null;
    const addressValue = String(
      source.address ||
        source.locationAddress ||
        fallbackAddress ||
        '',
    ).trim();
    return {
      latitude,
      longitude,
      lat: latitude,
      lng: longitude,
      address: addressValue,
      city: String(source.city || '').trim(),
      area: String(source.area || '').trim(),
      updatedAt: source.updatedAt || null,
    };
  }

  private parseDiscoveryInclude(includeRaw?: string) {
    const requested = String(includeRaw || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    if (!requested.length) {
      return ['MEDIC', 'PHARMACY_ADMIN', 'HOSPITAL_ADMIN'];
    }

    const includeRoles = new Set<string>();
    requested.forEach((entry) => {
      if (entry === 'medic' || entry === 'medics') includeRoles.add('MEDIC');
      if (entry === 'pharmacy' || entry === 'pharmacies') includeRoles.add('PHARMACY_ADMIN');
      if (entry === 'hospital' || entry === 'hospitals') includeRoles.add('HOSPITAL_ADMIN');
    });

    return includeRoles.size
      ? Array.from(includeRoles)
      : ['MEDIC', 'PHARMACY_ADMIN', 'HOSPITAL_ADMIN'];
  }

  @Get('online')
  async onlineUsers(
    @Req() req: any,
    @Query('roles') roles?: string,
    @Query('search') search?: string,
  ) {
    const onlineIds = this.notificationsGateway.listOnlineUserIds();
    if (!onlineIds.length) {
      return [];
    }

    const roleFilter = String(roles || '')
      .split(',')
      .map((role) => role.trim().toUpperCase())
      .filter(Boolean)
      .filter((role): role is UserRole =>
        Object.values(UserRole).includes(role as UserRole),
      );

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: onlineIds },
        ...(roleFilter.length ? { role: { in: roleFilter } } : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        lastLogin: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((user) => user.id));
    const query = String(search || '').trim().toLowerCase();
    const normalized = users
      .map((user) => {
        const extras = extrasMap.get(user.id) || {};
        const presence = this.notificationsGateway.getPresenceMeta(user.id);
        const firstName = String(extras.firstName || user.fullName?.split(' ')[0] || '').trim();
        const lastName = String(extras.lastName || user.fullName?.split(' ').slice(1).join(' ') || '').trim();
        const location =
          extras.location?.address ||
          extras.locationAddress ||
          extras.address ||
          extras.city ||
          '';
        return {
          id: user.id,
          fullName: user.fullName || `${firstName} ${lastName}`.trim(),
          firstName,
          lastName,
          role: user.role,
          email: user.email,
          phone: user.phone,
          location,
          isOnline: true,
          avatarUrl: extras.profilePhoto || extras.avatarUrl || null,
          onlineSince: presence?.onlineSince || null,
          lastSeenAt: presence?.lastSeenAt || user.lastLogin || null,
        };
      })
      .filter((item) => {
        if (!query) return true;
        const haystack = `${item.fullName} ${item.firstName} ${item.lastName} ${item.email || ''} ${item.role || ''} ${item.location || ''}`.toLowerCase();
        return haystack.includes(query);
      });

    return normalized;
  }

  private evaluateVitalsAlert(vital: Record<string, any>) {
    const alerts: Array<{ severity: 'HIGH' | 'MEDIUM'; title: string; message: string }> = [];
    const systolic = this.toNum(vital?.bloodPressureSystolic, NaN);
    const diastolic = this.toNum(vital?.bloodPressureDiastolic, NaN);
    const sugar = this.toNum(vital?.bloodSugar, NaN);
    const temp = this.toNum(vital?.temperature, NaN);
    const spo2 = this.toNum(vital?.spo2, NaN);
    const pulse = this.toNum(vital?.pulse, NaN);

    if (Number.isFinite(systolic) && Number.isFinite(diastolic) && (systolic >= 160 || diastolic >= 100)) {
      alerts.push({
        severity: 'HIGH',
        title: 'High Blood Pressure',
        message: `BP reading ${systolic}/${diastolic} is in a critical range.`,
      });
    }
    if (Number.isFinite(sugar) && sugar >= 240) {
      alerts.push({
        severity: 'HIGH',
        title: 'High Blood Sugar',
        message: `Blood sugar reading ${sugar} mg/dL is high.`,
      });
    }
    if (Number.isFinite(temp) && temp >= 38.5) {
      alerts.push({
        severity: 'MEDIUM',
        title: 'Fever Detected',
        message: `Temperature ${temp}°C may indicate infection.`,
      });
    }
    if (Number.isFinite(spo2) && spo2 < 92) {
      alerts.push({
        severity: 'HIGH',
        title: 'Low Oxygen Level',
        message: `SpO2 ${spo2}% is below safe threshold.`,
      });
    }
    if (Number.isFinite(pulse) && (pulse < 45 || pulse > 130)) {
      alerts.push({
        severity: 'MEDIUM',
        title: 'Pulse Out of Range',
        message: `Pulse ${pulse} bpm is out of expected range.`,
      });
    }
    return alerts;
  }

  private buildMedicationInteractions(medicationsInput: string[]) {
    const medications = medicationsInput.map((item) => String(item || '').trim()).filter(Boolean);
    const tokens = medications.map((item) => item.toUpperCase());
    const rules = [
      {
        a: 'WARFARIN',
        b: 'ASPIRIN',
        severity: 'HIGH',
        message: 'Increased bleeding risk when Warfarin is combined with Aspirin.',
      },
      {
        a: 'IBUPROFEN',
        b: 'PREDNISOLONE',
        severity: 'MEDIUM',
        message: 'GI irritation risk increases when Ibuprofen is combined with Prednisolone.',
      },
      {
        a: 'METFORMIN',
        b: 'ALCOHOL',
        severity: 'MEDIUM',
        message: 'Metformin with alcohol may increase lactic acidosis risk.',
      },
      {
        a: 'AZITHROMYCIN',
        b: 'ONDANSETRON',
        severity: 'MEDIUM',
        message: 'Combined use can increase risk of QT prolongation.',
      },
      {
        a: 'SILDENAFIL',
        b: 'NITROGLYCERIN',
        severity: 'HIGH',
        message: 'Severe hypotension risk when Sildenafil is combined with nitrates.',
      },
    ];

    const interactions = rules
      .filter((rule) => tokens.includes(rule.a) && tokens.includes(rule.b))
      .map((rule) => ({
        pair: [rule.a, rule.b],
        severity: rule.severity,
        message: rule.message,
      }));

    return {
      medications,
      interactions,
      safe: interactions.length === 0,
    };
  }

  private async resolvePatientScope(req: any, requestedPatientId?: string) {
    const role = this.normalizeRole(req.user?.role);
    const actorId = String(req.user?.userId || '').trim();
    const scopedPatientId = String(requestedPatientId || '').trim();

    if (role === 'PATIENT') {
      return actorId;
    }
    if (!scopedPatientId) {
      if (role === 'SUPER_ADMIN') return actorId;
      throw new BadRequestException('patientId is required.');
    }

    const patient = await this.prisma.user.findUnique({
      where: { id: scopedPatientId },
      select: { id: true, role: true },
    });
    if (!patient || this.normalizeRole(patient.role) !== 'PATIENT') {
      throw new BadRequestException('Invalid patient scope.');
    }

    if (role === 'SUPER_ADMIN' || role === 'HOSPITAL_ADMIN' || role === 'PHARMACY_ADMIN') {
      return patient.id;
    }

    if (role === 'MEDIC') {
      const extras = await getProfileExtras(this.prisma, patient.id);
      if (!this.hasMedicalRecordGrant(extras, actorId)) {
        throw new ForbiddenException(
          'Patient consent is required before viewing or updating health records.',
        );
      }
      return patient.id;
    }

    throw new ForbiddenException('Not allowed to access patient dashboard data.');
  }

  private computePreventiveReminders(user: any, extras: Record<string, any>, appointments: any[]) {
    const reminders: Array<{ id: string; title: string; due: string; priority: 'LOW' | 'MEDIUM' | 'HIGH' }> = [];
    const dateOfBirth = user?.dateOfBirth ? new Date(user.dateOfBirth) : null;
    const age = dateOfBirth
      ? Math.max(0, Math.floor((Date.now() - dateOfBirth.getTime()) / (1000 * 60 * 60 * 24 * 365.25)))
      : null;
    const gender = String(user?.gender || extras?.gender || '').toLowerCase();
    const chronic = String(extras?.chronicCondition || '').toLowerCase();

    if (!extras?.bloodGroup) {
      reminders.push({
        id: 'blood-group',
        title: 'Add blood group to profile',
        due: 'As soon as possible',
        priority: 'HIGH',
      });
    }
    if (!extras?.allergies) {
      reminders.push({
        id: 'allergies',
        title: 'Update allergy information',
        due: 'As soon as possible',
        priority: 'HIGH',
      });
    }
    if (!user?.emergencyContactPhone) {
      reminders.push({
        id: 'emergency-contact',
        title: 'Add emergency contact phone',
        due: 'As soon as possible',
        priority: 'HIGH',
      });
    }
    if (age !== null && age >= 40) {
      reminders.push({
        id: 'bp-check',
        title: 'Blood pressure check',
        due: 'Every 6 months',
        priority: 'MEDIUM',
      });
    }
    if (age !== null && age >= 50) {
      reminders.push({
        id: 'colon-screen',
        title: 'Colorectal screening',
        due: 'Yearly',
        priority: 'MEDIUM',
      });
    }
    if (gender === 'female' && age !== null && age >= 21) {
      reminders.push({
        id: 'cervical-screen',
        title: 'Cervical cancer screening',
        due: 'Every 3 years',
        priority: 'MEDIUM',
      });
    }
    if (chronic.includes('diabet')) {
      reminders.push({
        id: 'hba1c',
        title: 'HbA1c lab review',
        due: 'Every 3 months',
        priority: 'HIGH',
      });
    }
    if (appointments.length === 0) {
      reminders.push({
        id: 'annual-review',
        title: 'Book annual wellness review',
        due: 'This month',
        priority: 'LOW',
      });
    }
    return reminders.slice(0, 8);
  }

  private buildCriticalAlerts(input: {
    extras: Record<string, any>;
    vitals: any[];
    medications: any[];
    appointments: any[];
    recoveryStatus: string;
    healthScore: number;
    user: any;
  }) {
    const { extras, vitals, medications, appointments, recoveryStatus, healthScore, user } = input;
    const alerts: Array<{ severity: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; message: string }> = [];

    if (healthScore < 40 || recoveryStatus === 'CRITICAL') {
      alerts.push({
        severity: 'HIGH',
        title: 'Critical Health Score',
        message: `Health score is ${Math.round(healthScore)}%. Contact your care team immediately.`,
      });
    }
    const latestVital = vitals[0];
    if (latestVital) {
      alerts.push(...this.evaluateVitalsAlert(latestVital));
    }
    const missedStreak = medications.reduce((sum, med) => sum + this.toNum(med?.missedCount, 0), 0);
    if (missedStreak >= 3) {
      alerts.push({
        severity: 'MEDIUM',
        title: 'Missed Medication Doses',
        message: `You have ${missedStreak} missed doses. Please review your care plan.`,
      });
    }
    if (!user?.emergencyContactPhone) {
      alerts.push({
        severity: 'MEDIUM',
        title: 'Emergency Contact Missing',
        message: 'Add an emergency contact phone in your profile.',
      });
    }
    if (appointments.length === 0 && recoveryStatus !== 'RECOVERED') {
      alerts.push({
        severity: 'MEDIUM',
        title: 'No Follow-up Scheduled',
        message: 'Book a follow-up appointment to continue treatment safely.',
      });
    }
    if (String(extras?.subscriptionActive ?? true) === 'false') {
      alerts.push({
        severity: 'LOW',
        title: 'Subscription Inactive',
        message: 'Renew subscription to maintain uninterrupted care services.',
      });
    }
    return alerts.slice(0, 8);
  }

  @Get('profile')
  async getProfile(@Req() req: any) {
    const userId = req.user.userId;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { medicProfile: true, tenants: { include: { tenant: true } } },
    });

    const extras = await getProfileExtras(this.prisma, userId);

    if (!user) return { user: null };

    return {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        emergencyContactName: user.emergencyContactName,
        emergencyContactPhone: user.emergencyContactPhone,
        passwordChangedAt: user.passwordChangedAt,
        passwordUpdateIntervalDays: user.passwordUpdateIntervalDays || null,
        passwordExpiresAt: user.passwordExpiresAt || null,
        passwordExpired: isPasswordExpired(user.passwordExpiresAt),
        passwordDaysRemaining: getPasswordDaysRemaining(user.passwordExpiresAt),
        medicProfile: user.medicProfile,
        tenants: user.tenants?.map((t) => t.tenant) || [],
        ...extras,
      },
    };
  }

  @Get('support-admin')
  async getSupportAdmin(@Req() req: any) {
    const currentUserId = req.user?.userId;
    const admins = await this.prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });

    if (!admins.length) return null;

    const selected = admins.find((item) => item.id !== currentUserId) || admins[0];
    return selected;
  }

  @Get('patients-directory')
  async listPatientsDirectory(@Req() req: any, @Query('search') search?: string, @Query('limit') limit?: string) {
    const role = this.normalizeRole(req.user?.role);
    if (!['SUPER_ADMIN', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN', 'MEDIC'].includes(role)) {
      throw new ForbiddenException('Not allowed to access patient directory.');
    }

    const take = Math.max(1, Math.min(100, Number(limit || 50)));
    const normalizedSearch = String(search || '').trim();
    const viewerId = String(req.user?.userId || '').trim();
    const orders = InMemoryStore.list('orders') as any[];
    const hires = InMemoryStore.list('medicHires') as any[];

    let scopedPatientIds: string[] | null = null;
    if (role === 'MEDIC') {
      const appointmentRows = await this.prisma.appointment.findMany({
        where: { medicId: viewerId },
        select: { patientId: true },
      });
      scopedPatientIds = Array.from(
        new Set(
          appointmentRows
            .map((appt) => String(appt.patientId || '').trim())
            .filter(Boolean),
        ),
      );
    } else if (role === 'HOSPITAL_ADMIN') {
      const myMedics = hires
        .filter((hire) => String(hire.hospitalAdminId || '') === viewerId)
        .map((hire) => String(hire.medicId || '').trim())
        .filter(Boolean);
      const appointmentRows = myMedics.length
        ? await this.prisma.appointment.findMany({
            where: { medicId: { in: myMedics } },
            select: { patientId: true },
          })
        : [];
      scopedPatientIds = Array.from(
        new Set(
          appointmentRows
            .map((appt) => String(appt.patientId || '').trim())
            .filter(Boolean),
        ),
      );
    } else if (role === 'PHARMACY_ADMIN') {
      scopedPatientIds = Array.from(
        new Set(
          orders
            .filter((order) => String(order.pharmacyId || '') === viewerId)
            .map((order) => String(order.patientId || '').trim())
            .filter(Boolean),
        ),
      );
    }

    if (scopedPatientIds && scopedPatientIds.length === 0) {
      return [];
    }

    const searchFilter: Prisma.UserWhereInput = normalizedSearch
      ? {
          OR: [
            { fullName: { contains: normalizedSearch, mode: Prisma.QueryMode.insensitive } },
            { email: { contains: normalizedSearch, mode: Prisma.QueryMode.insensitive } },
            { phone: { contains: normalizedSearch, mode: Prisma.QueryMode.insensitive } },
          ],
        }
      : {};

    const patients = await this.prisma.user.findMany({
      where: {
        role: UserRole.PATIENT,
        ...(scopedPatientIds ? { id: { in: scopedPatientIds } } : {}),
        ...searchFilter,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, patients.map((item) => item.id));
    return patients.map((patient) => ({
      ...patient,
      avatarUrl:
        extrasMap.get(patient.id)?.profilePhoto ||
        extrasMap.get(patient.id)?.profilePhotoUrl ||
        null,
    }));
  }

  @Get('patient-dashboard')
  async getPatientDashboard(@Req() req: any, @Query('patientId') requestedPatientId?: string) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);

    const [user, extras, recordsRaw] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: patientId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
        },
      }),
      getProfileExtras(this.prisma, patientId),
      this.prisma.medicalRecord.findMany({
        where: { patientId },
        include: { medic: { select: { id: true, fullName: true, email: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!user) {
      throw new BadRequestException('Patient account not found.');
    }

    const appointments = await this.prisma.appointment.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });
    const orders = (InMemoryStore.list('orders') as any[])
      .filter((item) => String(item?.patientId || '') === patientId)
      .sort(
        (a, b) =>
          new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime(),
      );
    const payments = (InMemoryStore.list('payments') as any[])
      .filter((item) => String(item?.userId || '') === patientId)
      .sort(
        (a, b) =>
          new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime(),
      );

    const storedMeds = Array.isArray(extras?.carePlanMeds) ? extras.carePlanMeds : [];
    const derivedMeds = recordsRaw
      .filter((record) => String(record?.type || '').toLowerCase() === 'prescription')
      .flatMap((record) => {
        const attachmentMeta = Array.isArray(record?.attachments)
          ? record.attachments.find((item: unknown) => {
              if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
              return String((item as Record<string, unknown>).kind || '') === 'prescription_meta';
            })
          : null;
        const attachmentMetaObj =
          attachmentMeta && typeof attachmentMeta === 'object' && !Array.isArray(attachmentMeta)
            ? (attachmentMeta as Record<string, unknown>)
            : null;
        const medications = this.parseMedicationList(
          attachmentMetaObj?.medications ?? record?.notes ?? '',
        );
        return medications.map((name) => {
          const dosage =
            typeof attachmentMetaObj?.dosage === 'string' ? attachmentMetaObj.dosage : '';
          const frequency =
            typeof attachmentMetaObj?.frequency === 'string'
              ? attachmentMetaObj.frequency
              : 'As prescribed';
          const takeTimes = this.parseTimeList(
            attachmentMetaObj?.takeTimes ?? attachmentMetaObj?.takeTime ?? attachmentMetaObj?.time,
          );
          const takeTime = takeTimes.length > 0 ? takeTimes[0] : null;
          const pillsPerDose = this.toFiniteOrNull(
            attachmentMetaObj?.pillsPerDose ?? attachmentMetaObj?.pills,
          );
          return {
            id: randomUUID(),
            name,
            dosage,
            frequency,
            takeTime,
            takeTimes,
            pillsPerDose,
            active: true,
            takenCount: 0,
            missedCount: 0,
            nextDoseAt: null,
            sourceRecordId: record.id,
          };
        });
      });
    const medByName = new Map<string, any>();
    [...storedMeds, ...derivedMeds].forEach((med) => {
      const key = String(med?.name || '').trim().toUpperCase();
      if (!key) return;
      if (!medByName.has(key)) medByName.set(key, med);
    });
    const medications = Array.from(medByName.values()).slice(0, 20);

    const vitals = (Array.isArray(extras?.vitalsLogs) ? extras.vitalsLogs : [])
      .slice()
      .sort(
        (a: any, b: any) =>
          new Date(b?.recordedAt || b?.createdAt || 0).getTime() -
          new Date(a?.recordedAt || a?.createdAt || 0).getTime(),
      )
      .slice(0, 20);

    const nextAppointment = appointments
      .filter((item) => new Date(item?.date || 0).getTime() >= Date.now())
      .sort((a, b) => new Date(a?.date || 0).getTime() - new Date(b?.date || 0).getTime())[0];

    const recoveryStatus = this.normalizeRole(extras?.recoveryStatus || 'UNDER_TREATMENT');
    const healthScoreRaw = this.toNum(extras?.healthScore, recoveryStatus === 'RECOVERED' ? 100 : 72);
    const healthScore = Math.max(0, Math.min(100, healthScoreRaw));

    const takenCount = medications.reduce((sum, med) => sum + this.toNum(med?.takenCount, 0), 0);
    const missedCount = medications.reduce((sum, med) => sum + this.toNum(med?.missedCount, 0), 0);
    const totalDoseEvents = takenCount + missedCount;
    const medicationAdherence = totalDoseEvents > 0 ? (takenCount / totalDoseEvents) * 100 : 100;
    const attendedAppointments = appointments.filter((item) =>
      ['COMPLETED', 'ATTENDED'].includes(this.normalizeRole(item?.status)),
    ).length;
    const missedAppointments = appointments.filter((item) =>
      ['NO_SHOW', 'MISSED', 'CANCELLED', 'CANCELED'].includes(this.normalizeRole(item?.status)),
    ).length;
    const appointmentEvents = attendedAppointments + missedAppointments;
    const appointmentAdherence = appointmentEvents > 0 ? (attendedAppointments / appointmentEvents) * 100 : 100;
    const adherenceScore = Math.round(medicationAdherence * 0.7 + appointmentAdherence * 0.3);

    const insurance = {
      provider: extras?.insuranceProvider || null,
      memberNumber: extras?.insuranceMemberNumber || null,
      planName: extras?.insurancePlanName || null,
      coveragePercent: this.toNum(extras?.insuranceCoveragePercent, 0),
      coveredAmount: this.toNum(extras?.insuranceCoveredAmount, 0),
      outOfPocketAmount: this.toNum(extras?.insuranceOutOfPocketAmount, 0),
      claimsPending: this.toNum(extras?.insuranceClaimsPending, 0),
      totalPaidFromApp: payments
        .filter((item) => this.normalizeRole(item?.status) === 'PAID')
        .reduce((sum, item) => sum + this.toNum(item?.amount, 0), 0),
    };

    const labs = recordsRaw
      .filter((record) =>
        ['lab', 'lab_result', 'imaging'].includes(String(record?.type || '').toLowerCase()) ||
        (Array.isArray(record?.attachments) &&
          record.attachments.some((item: any) => String(item?.kind || '').includes('lab'))),
      )
      .slice(0, 20)
      .map((record) => ({
        id: record.id,
        title: record.condition || record.notes || 'Lab/Imaging Result',
        summary: record.notes || '',
        status:
          this.normalizeRole((record as any)?.status || '') === 'ABNORMAL' ? 'ABNORMAL' : 'NORMAL_OR_REVIEW',
        createdAt: record.createdAt,
      }));

    const timeline = [
      ...recordsRaw.map((record) => ({
        id: `record-${record.id}`,
        type: 'MEDICAL_RECORD',
        title: 'Medical Record',
        recordType: String(record?.type || 'record').toUpperCase(),
        medicName: record?.medic?.fullName || null,
        detail: record?.notes || record?.condition || 'Medical record update',
        date: record.createdAt,
      })),
      ...appointments.map((appointment) => ({
        id: `appointment-${appointment.id}`,
        type: 'APPOINTMENT',
        title: 'Appointment',
        detail: `${appointment?.date || ''} ${appointment?.time || ''} (${appointment?.status || 'confirmed'})`.trim(),
        date: appointment?.date || appointment?.createdAt || new Date().toISOString(),
      })),
      ...orders.map((order) => ({
        id: `order-${order.id}`,
        type: 'PHARMACY_ORDER',
        title: 'Pharmacy Order',
        detail: `${order?.status || 'PENDING'} • KES ${this.toNum(order?.total, 0).toLocaleString()}`,
        date: order?.createdAt || new Date().toISOString(),
      })),
      ...payments.map((payment) => ({
        id: `payment-${payment.id}`,
        type: 'PAYMENT',
        title: 'Payment',
        detail: `${payment?.status || 'PENDING'} • KES ${this.toNum(payment?.amount, 0).toLocaleString()}`,
        date: payment?.createdAt || new Date().toISOString(),
      })),
    ]
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
      .slice(0, 50);

    const medicIds = Array.from(
      new Set(
        [
          ...appointments.map((item) => item?.medicId),
          ...recordsRaw.map((item) => item?.medicId),
        ]
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    );
    const medicUsers = medicIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: medicIds } },
          select: { id: true, fullName: true, email: true, phone: true },
        })
      : [];
    const hospitalHires = (InMemoryStore.list('medicHires') as any[]).filter((hire) =>
      medicIds.includes(String(hire?.medicId || '')),
    );
    const hospitalIds = Array.from(
      new Set(
        hospitalHires
          .map((hire) => String(hire?.hospitalAdminId || '').trim())
          .filter(Boolean),
      ),
    );
    const hospitalUsers = hospitalIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: hospitalIds } },
          select: { id: true, fullName: true, email: true, phone: true },
        })
      : [];
    const pharmacyTenantIds = Array.from(
      new Set(
        orders
          .map((order) => String(order?.pharmacyId || '').trim())
          .filter(Boolean),
      ),
    );
    const pharmacies = pharmacyTenantIds.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: pharmacyTenantIds } },
          select: { id: true, name: true, phone: true, email: true, location: true },
        })
      : [];

    const preventiveReminders = this.computePreventiveReminders(user, extras, appointments);
    const criticalAlerts = this.buildCriticalAlerts({
      extras,
      vitals,
      medications,
      appointments,
      recoveryStatus,
      healthScore,
      user,
    });
    const healthShares = (Array.isArray(extras?.healthShares) ? extras.healthShares : [])
      .filter((item: any) => new Date(item?.expiresAt || 0).getTime() > Date.now())
      .map((item: any) => {
        const token = String(item?.token || '').trim();
        const apiPath = token ? `/users/patient-health-share/${token}` : null;
        const viewerPath = token ? `/shared/health/${token}` : null;
        return {
          ...item,
          apiPath: item?.apiPath || apiPath,
          viewerPath: item?.viewerPath || viewerPath,
          link: item?.link || apiPath || viewerPath,
        };
      })
      .slice(0, 10);

    return {
      generatedAt: new Date().toISOString(),
      carePlan: {
        medications,
        goals: Array.isArray(extras?.careGoals)
          ? extras.careGoals
          : [
              'Take prescribed medication on schedule',
              'Attend follow-up appointments',
              'Track vitals daily',
            ],
        nextFollowUp: nextAppointment || null,
      },
      medicationSafety: extras?.medicationSafetyLastCheck || null,
      emergencyCard: {
        fullName: user.fullName || '',
        bloodGroup: extras?.bloodGroup || null,
        allergies: extras?.allergies || null,
        chronicCondition: extras?.chronicCondition || null,
        emergencyContactName: user.emergencyContactName || null,
        emergencyContactPhone: user.emergencyContactPhone || null,
      },
      vitals,
      insurance,
      labs,
      timeline,
      healthShare: {
        activeLinks: healthShares,
      },
      careTeam: {
        medics: medicUsers,
        hospitals: hospitalUsers,
        pharmacies,
      },
      adherence: {
        overallScore: Math.max(0, Math.min(100, adherenceScore)),
        medicationAdherence: Number(medicationAdherence.toFixed(1)),
        appointmentAdherence: Number(appointmentAdherence.toFixed(1)),
      },
      preventiveReminders,
      criticalAlerts,
    };
  }

  @Post('patient-vitals')
  async addPatientVitals(@Req() req: any, @Body() body: any, @Query('patientId') requestedPatientId?: string) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const extras = await getProfileExtras(this.prisma, patientId);
    const reading = {
      id: randomUUID(),
      bloodPressureSystolic: body?.bloodPressureSystolic ?? body?.systolic ?? null,
      bloodPressureDiastolic: body?.bloodPressureDiastolic ?? body?.diastolic ?? null,
      bloodSugar: body?.bloodSugar ?? null,
      temperature: body?.temperature ?? null,
      spo2: body?.spo2 ?? body?.oxygen ?? null,
      pulse: body?.pulse ?? body?.heartRate ?? null,
      weight: body?.weight ?? null,
      note: body?.note || '',
      recordedAt: new Date().toISOString(),
      recordedBy: req.user?.userId || null,
    };
    const hasValue =
      reading.bloodPressureSystolic !== null ||
      reading.bloodPressureDiastolic !== null ||
      reading.bloodSugar !== null ||
      reading.temperature !== null ||
      reading.spo2 !== null ||
      reading.pulse !== null ||
      reading.weight !== null;
    if (!hasValue) {
      throw new BadRequestException('At least one vital value is required.');
    }

    const vitals = [...(Array.isArray(extras?.vitalsLogs) ? extras.vitalsLogs : []), reading].slice(-200);
    await mergeProfileExtras(this.prisma, patientId, { vitalsLogs: vitals });
    return {
      success: true,
      reading,
      alerts: this.evaluateVitalsAlert(reading),
    };
  }

  @Post('patient-medication-check')
  async checkMedicationSafety(@Req() req: any, @Body() body: any, @Query('patientId') requestedPatientId?: string) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const medications = this.parseMedicationList(body?.medications);
    if (!medications.length) {
      throw new BadRequestException('Provide at least one medication to check.');
    }
    const result = this.buildMedicationInteractions(medications);
    const lastCheck = {
      ...result,
      checkedAt: new Date().toISOString(),
      checkedBy: req.user?.userId || null,
    };
    await mergeProfileExtras(this.prisma, patientId, { medicationSafetyLastCheck: lastCheck });
    return lastCheck;
  }

  @Post('patient-health-share')
  async createHealthShare(@Req() req: any, @Body() body: any, @Query('patientId') requestedPatientId?: string) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const extras = await getProfileExtras(this.prisma, patientId);
    const expiresHours = Math.max(1, Math.min(168, this.toNum(body?.expiresHours, 24)));
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + expiresHours * 60 * 60 * 1000);
    const token = randomUUID().replace(/-/g, '');
    const apiPath = `/users/patient-health-share/${token}`;
    const viewerPath = `/shared/health/${token}`;
    const share = {
      id: randomUUID(),
      token,
      scope: body?.scope || 'SUMMARY',
      note: body?.note || '',
      targetId: body?.targetId || null,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      link: apiPath,
      apiPath,
      viewerPath,
    };
    const shares = [...(Array.isArray(extras?.healthShares) ? extras.healthShares : []), share].slice(-50);
    await mergeProfileExtras(this.prisma, patientId, { healthShares: shares });
    return { success: true, share };
  }

  @Get('patient-health-share/:token')
  async resolveHealthShare(@Param('token') token: string) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
      throw new BadRequestException('Share token is required.');
    }

    const profiles = await this.prisma.userProfile.findMany({
      select: { userId: true, data: true },
    });

    let patientId: string | null = null;
    let patientExtras: Record<string, any> = {};
    let matchedShare: Record<string, any> | null = null;

    for (const profile of profiles) {
      const extras =
        profile?.data && typeof profile.data === 'object' && !Array.isArray(profile.data)
          ? (profile.data as Record<string, any>)
          : {};
      const shares = Array.isArray(extras?.healthShares) ? extras.healthShares : [];
      const found = shares.find((share: any) => String(share?.token || '') === normalizedToken);
      if (found) {
        patientId = profile.userId;
        patientExtras = extras;
        matchedShare = found;
        break;
      }
    }

    if (!patientId || !matchedShare) {
      throw new BadRequestException('Share token not found.');
    }

    if (new Date(matchedShare?.expiresAt || 0).getTime() <= Date.now()) {
      throw new ForbiddenException('Share token expired.');
    }

    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: {
        id: true,
        fullName: true,
        dateOfBirth: true,
        gender: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
      },
    });

    if (!patient) {
      throw new BadRequestException('Patient account not found.');
    }

    const scope = String(matchedShare?.scope || 'SUMMARY').toUpperCase();
    const maxRecords = scope === 'FULL' ? 20 : 8;
    const records = await this.prisma.medicalRecord.findMany({
      where: { patientId },
      select: {
        id: true,
        type: true,
        condition: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: maxRecords,
    });

    const vitals = (Array.isArray(patientExtras?.vitalsLogs) ? patientExtras.vitalsLogs : [])
      .slice()
      .sort(
        (a: any, b: any) =>
          new Date(b?.recordedAt || b?.createdAt || 0).getTime() -
          new Date(a?.recordedAt || a?.createdAt || 0).getTime(),
      )
      .slice(0, maxRecords);

    const medications = (Array.isArray(patientExtras?.carePlanMeds) ? patientExtras.carePlanMeds : []).slice(
      0,
      maxRecords,
    );

    return {
      token: normalizedToken,
      scope,
      expiresAt: matchedShare.expiresAt,
      sharedAt: matchedShare.createdAt || null,
      note: matchedShare.note || '',
      patient: {
        id: patient.id,
        fullName: patient.fullName || '',
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
      },
      emergencyCard: {
        bloodGroup: patientExtras?.bloodGroup || null,
        allergies: patientExtras?.allergies || null,
        chronicCondition: patientExtras?.chronicCondition || null,
        emergencyContactName: patient.emergencyContactName || null,
        emergencyContactPhone: patient.emergencyContactPhone || null,
      },
      medications,
      vitals,
      records,
    };
  }

  @Post('patient-care-plan/medications')
  async addCarePlanMedication(@Req() req: any, @Body() body: any, @Query('patientId') requestedPatientId?: string) {
    const role = this.normalizeRole(req.user?.role);
    if (!['MEDIC', 'HOSPITAL_ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw new ForbiddenException('Only medics or hospitals can update care plans.');
    }
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const extras = await getProfileExtras(this.prisma, patientId);
    const name = String(body?.name || '').trim();
    if (!name) {
      throw new BadRequestException('Medication name is required.');
    }
    const takeTimes = this.parseTimeList(body?.takeTimes ?? body?.takeTime ?? body?.time);
    if (takeTimes.length === 0) {
      throw new BadRequestException('Take time is required.');
    }
    const takeTime = takeTimes[0] || null;
    const pillsPerDose = this.toFiniteOrNull(body?.pillsPerDose ?? body?.pills);
    const medication = {
      id: randomUUID(),
      name,
      dosage: body?.dosage || '',
      frequency: body?.frequency || 'As prescribed',
      takeTime: takeTime || null,
      takeTimes,
      pillsPerDose,
      nextDoseAt: body?.nextDoseAt || null,
      active: body?.active !== false,
      takenCount: 0,
      missedCount: 0,
      createdAt: new Date().toISOString(),
    };
    const medications = [...(Array.isArray(extras?.carePlanMeds) ? extras.carePlanMeds : []), medication].slice(-100);
    await mergeProfileExtras(this.prisma, patientId, { carePlanMeds: medications });
    return { success: true, medication };
  }

  @Post('patient-care-plan/medications/:medicationId/take')
  async markMedicationTaken(
    @Req() req: any,
    @Param('medicationId') medicationId: string,
    @Query('patientId') requestedPatientId?: string,
  ) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const extras = await getProfileExtras(this.prisma, patientId);
    const medications = Array.isArray(extras?.carePlanMeds) ? extras.carePlanMeds : [];
    let matched = false;
    const updated = medications.map((med: any) => {
      if (String(med?.id || '') !== medicationId) return med;
      matched = true;
      return {
        ...med,
        lastTakenAt: new Date().toISOString(),
        takenCount: this.toNum(med?.takenCount, 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!matched) {
      throw new BadRequestException('Medication not found in care plan.');
    }
    await mergeProfileExtras(this.prisma, patientId, { carePlanMeds: updated });
    return { success: true };
  }

  @Post('patient-care-plan/medications/:medicationId/miss')
  async markMedicationMissed(
    @Req() req: any,
    @Param('medicationId') medicationId: string,
    @Query('patientId') requestedPatientId?: string,
  ) {
    const patientId = await this.resolvePatientScope(req, requestedPatientId);
    const extras = await getProfileExtras(this.prisma, patientId);
    const medications = Array.isArray(extras?.carePlanMeds) ? extras.carePlanMeds : [];
    let matched = false;
    const updated = medications.map((med: any) => {
      if (String(med?.id || '') !== medicationId) return med;
      matched = true;
      return {
        ...med,
        missedCount: this.toNum(med?.missedCount, 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!matched) {
      throw new BadRequestException('Medication not found in care plan.');
    }
    await mergeProfileExtras(this.prisma, patientId, { carePlanMeds: updated });
    return { success: true };
  }

  @Get(':id')
  async getUserById(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, fullName: true, role: true, lastLogin: true, createdAt: true },
    });
    if (!user) return null;
    const extras = await getProfileExtras(this.prisma, id);
    return {
      ...user,
      avatarUrl: extras.profilePhoto || extras.avatarUrl || null,
    };
  }

  @Put('security/password-policy')
  async updatePasswordPolicy(@Req() req: any, @Body() body: any) {
    const userId = String(req.user?.userId || '').trim();
    if (!userId) throw new BadRequestException('Invalid user session.');

    const rawInterval = body?.passwordUpdateIntervalDays ?? body?.intervalDays ?? null;
    const intervalDays = normalizePasswordIntervalDays(rawInterval);

    const shouldDisable =
      rawInterval === null ||
      rawInterval === undefined ||
      rawInterval === '' ||
      Number(rawInterval) === 0;
    if (!shouldDisable && intervalDays === null) {
      throw new BadRequestException(
        `Invalid interval. Allowed values: ${ALLOWED_PASSWORD_INTERVAL_DAYS.join(', ')} days, or 0 to disable.`,
      );
    }

    const now = new Date();
    const passwordExpiresAt = computePasswordExpiryDate(intervalDays, now);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordUpdateIntervalDays: intervalDays,
        passwordExpiresAt,
      },
    });

    return {
      success: true,
      passwordPolicy: {
        intervalDays,
        expiresAt: passwordExpiresAt,
        daysRemaining: getPasswordDaysRemaining(passwordExpiresAt),
      },
    };
  }

  @Put('security/password')
  async changePassword(@Req() req: any, @Body() body: any) {
    const userId = String(req.user?.userId || '').trim();
    if (!userId) throw new BadRequestException('Invalid user session.');

    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current password and new password are required.');
    }
    if (newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        password: true,
        passwordUpdateIntervalDays: true,
      },
    });
    if (!user) throw new BadRequestException('User account not found.');

    const validCurrent = await bcrypt.compare(currentPassword, user.password);
    if (!validCurrent) {
      throw new BadRequestException('Current password is incorrect.');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    const changedAt = new Date();
    const intervalDays = normalizePasswordIntervalDays(user.passwordUpdateIntervalDays);
    const passwordExpiresAt = computePasswordExpiryDate(intervalDays, changedAt);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        passwordChangedAt: changedAt,
        passwordExpiresAt,
      },
    });

    return {
      success: true,
      passwordPolicy: {
        intervalDays,
        expiresAt: passwordExpiresAt,
        daysRemaining: getPasswordDaysRemaining(passwordExpiresAt),
      },
    };
  }

  @Put('profile')
  async updateProfile(@Req() req: any, @Body() body: any) {
    const userId = req.user.userId;

    const fullName = body.fullName || `${body.firstName || ''} ${body.lastName || ''}`.trim();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        fullName: fullName || undefined,
        phone: body.phone || undefined,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
        gender: body.gender || undefined,
        emergencyContactName: body.emergencyContactName || undefined,
        emergencyContactPhone: body.emergencyContactPhone || undefined,
      },
    });

    await mergeProfileExtras(this.prisma, userId, {
      firstName: body.firstName,
      lastName: body.lastName,
      address: body.address,
      homeCountry: body.homeCountry,
      subCounty: body.subCounty,
      ward: body.ward,
      preferredLanguage: body.preferredLanguage,
      bloodGroup: body.bloodGroup,
      allergies: body.allergies,
      chronicCondition: body.chronicCondition,
      emergencyContactRelationship: body.emergencyContactRelationship,
      location: body.location,
      county: body.county,
      townCity: body.townCity,
      nearestTown: body.nearestTown,
      locationTown: body.locationTown,
      profilePhoto: body.profilePhoto,
      profilePhotoUrl: body.profilePhotoUrl,
      idFront: body.idFront,
      idFrontName: body.idFrontName,
      idBack: body.idBack,
      idBackName: body.idBackName,
      license: body.license,
      licenseUrl: body.licenseUrl,
      licenseName: body.licenseName,
      adminId: body.adminId,
      adminIdUrl: body.adminIdUrl,
      adminIdName: body.adminIdName,
      cv: body.cv,
      cvUrl: body.cvUrl,
      cvName: body.cvName,
      specialization: body.specialization,
      professionalType: body.professionalType,
      licenseNumber: body.licenseNumber,
      institution: body.institution,
      qualifications: body.qualifications,
      yearCompleted: body.yearCompleted,
      certifications: body.certifications,
      experienceYears: body.experienceYears,
      consultationFee: body.consultationFee,
      rating: body.rating,
      availability: body.availability,
      availableDays: body.availableDays,
      languages: body.languages,
      availableCounties: body.availableCounties,
      preferredShiftTypes: body.preferredShiftTypes,
      hourlyRate: body.hourlyRate,
      modeOfTransport: body.modeOfTransport,
      bankName: body.bankName,
      bankAccountNumber: body.bankAccountNumber,
      bankAccountName: body.bankAccountName,
      verificationStatus: body.verificationStatus,
      verifiedAt: body.verifiedAt,
      services: body.services,
      paymentModes: body.paymentModes,
      patientVolume: body.patientVolume,
      pharmacyName: body.pharmacyName,
      pharmacyType: body.pharmacyType,
      facilityType: body.facilityType,
      registrationNumber: body.registrationNumber,
      hospitalName: body.hospitalName,
      adminName: body.adminName,
      adminEmail: body.adminEmail,
      adminContact: body.adminContact,
      website: body.website,
      managerName: body.managerName,
      managerPhone: body.managerPhone,
      bedCapacity: body.bedCapacity,
      specialties: body.specialties,
      operatingHours: body.operatingHours,
      workingDays: body.workingDays,
      ownerName: body.ownerName,
      ownerPhone: body.ownerPhone,
      ownerEmail: body.ownerEmail,
      ownerIdFront: body.ownerIdFront,
      ownerIdBack: body.ownerIdBack,
      ownerIdFrontName: body.ownerIdFrontName,
      ownerIdBackName: body.ownerIdBackName,
      offDays: body.offDays,
      deliveryAvailable: body.deliveryAvailable,
      deliveryFee: body.deliveryFee,
      pharmacistInChargeName: body.pharmacistInChargeName,
      pharmacistInChargePhone: body.pharmacistInChargePhone,
      pharmacistInChargeEmail: body.pharmacistInChargeEmail,
      paymentMethod: body.paymentMethod,
      locationAddress: body.locationAddress,
      notificationSettings: body.notificationSettings,
      privacySettings: body.privacySettings,
      supportSettings: body.supportSettings,
      termsAcceptedAt: body.termsAcceptedAt,
      privacyPolicyAcceptedAt: body.privacyPolicyAcceptedAt,
      marketingConsent: body.marketingConsent,
    });

    return { success: true };
  }

  @Get('location')
  async getMyLocation(@Req() req: any) {
    const userId = req.user?.userId;
    const extras = await getProfileExtras(this.prisma, userId);
    return { location: extras.location || null };
  }

  @Put('location')
  async updateLocation(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId;
    const lat = Number(body.latitude ?? body.lat);
    const lng = Number(body.longitude ?? body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { success: false, message: 'Invalid coordinates' };
    }
    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLng = Math.round(lng * 10000) / 10000;
    const location = {
      latitude: roundedLat,
      longitude: roundedLng,
      address: body.address || body.locationAddress || '',
      label: body.label || '',
      city: body.city || '',
      area: body.area || '',
      precision: 'approx',
      updatedAt: new Date().toISOString(),
    };
    await mergeProfileExtras(this.prisma, userId, { location });
    return { success: true, location };
  }

  @Get('map-discovery')
  async getMapDiscovery(
    @Query('include') include?: string,
    @Query('userId') userId?: string,
    @Query('service') service?: string,
  ) {
    const roles = this.parseDiscoveryInclude(include);
    const targetUserId = String(userId || '').trim();
    const serviceFilter = String(service || '').trim().toLowerCase();

    const users = await this.prisma.user.findMany({
      where: {
        role: { in: roles as any },
        status: 'active',
        ...(targetUserId ? { id: targetUserId } : {}),
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        phone: true,
        status: true,
        medicProfile: {
          select: {
            specialization: true,
            experienceYears: true,
            consultationFee: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: targetUserId ? 1 : 500,
    });

    if (!users.length) return { items: [] };

    const userIds = users.map((user) => user.id);
    const [extrasMap, tenantLinks] = await Promise.all([
      getProfileExtrasMap(this.prisma, userIds),
      this.prisma.tenantUser.findMany({
        where: {
          userId: { in: userIds },
          tenant: { type: { in: ['PHARMACY', 'HOSPITAL'] } },
        },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              phone: true,
              email: true,
            },
          },
        },
      }),
    ]);

    const tenantByUser = new Map<string, any>();
    tenantLinks.forEach((link) => {
      const key = String(link.userId || '');
      if (!key) return;
      const current = tenantByUser.get(key);
      if (!current || (!current.isPrimary && Boolean(link.isPrimary))) {
        tenantByUser.set(key, link);
      }
    });

    const hospitalTenantIds = Array.from(
      new Set(
        tenantLinks
          .filter((link) => String(link?.tenant?.type || '').toUpperCase() === 'HOSPITAL')
          .map((link) => String(link?.tenant?.id || link?.tenantId || ''))
          .filter(Boolean),
      ),
    );
    const db = this.prisma as any;
    const hospitalServiceRows = hospitalTenantIds.length
      ? await db.hospitalService.findMany({
          where: { tenantId: { in: hospitalTenantIds } },
          select: {
            tenantId: true,
            name: true,
            category: true,
            description: true,
            department: true,
            availability: true,
            equipment: true,
            status: true,
          },
        })
      : [];
    const servicesByTenant = new Map<string, string[]>();
    const serviceDetailsByTenant = new Map<string, any[]>();
    const serviceTokensByTenant = new Map<string, string[]>();
    hospitalServiceRows.forEach((row) => {
      const key = String(row.tenantId || '');
      if (!key) return;
      const list = servicesByTenant.get(key) || [];
      if (row.name) list.push(String(row.name));
      servicesByTenant.set(key, list);
      const detailList = serviceDetailsByTenant.get(key) || [];
      detailList.push({
        name: row.name || null,
        category: row.category || null,
        availability: row.availability || null,
        department: row.department || null,
        status: row.status || null,
        costMin: row.costMin ?? null,
        costMax: row.costMax ?? null,
      });
      serviceDetailsByTenant.set(key, detailList);
      const tokens = serviceTokensByTenant.get(key) || [];
      const pushToken = (value?: string | null) => {
        if (!value) return;
        const text = String(value).trim();
        if (!text) return;
        tokens.push(text.toLowerCase());
      };
      pushToken(row.name);
      pushToken(row.category);
      pushToken(row.description);
      pushToken(row.department);
      pushToken(row.availability);
      if (Array.isArray(row.equipment)) {
        row.equipment.forEach((item: any) => pushToken(item));
      }
      serviceTokensByTenant.set(key, tokens);
    });

    const items = users
      .map((user) => {
        const role = this.normalizeRole(user.role);
        const extras = extrasMap.get(user.id) || {};
        const tenantLink = tenantByUser.get(user.id);
        const tenant = tenantLink?.tenant || null;
        const mappedLocation = this.normalizeGeoLocation(
          extras.location,
          String(extras.locationAddress || ''),
        );
        if (!mappedLocation) return null;

        const kind =
          role === 'MEDIC'
            ? 'medic'
            : role === 'PHARMACY_ADMIN'
              ? 'pharmacy'
              : role === 'HOSPITAL_ADMIN'
                ? 'hospital'
                : 'user';

        const displayName =
          role === 'PHARMACY_ADMIN'
            ? String(extras.pharmacyName || tenant?.name || user.fullName || 'Pharmacy').trim()
            : role === 'HOSPITAL_ADMIN'
              ? String(extras.hospitalName || tenant?.name || user.fullName || 'Hospital').trim()
              : String(user.fullName || extras.fullName || 'User').trim();

        return {
          id: user.id,
          userId: user.id,
          role,
          kind,
          name: displayName || 'User',
          email: user.email || null,
          phone: user.phone || null,
          status: user.status || 'active',
          location: mappedLocation,
          specialization:
            role === 'MEDIC'
              ? String(
                  user.medicProfile?.specialization ||
                    extras.specialization ||
                    extras.professionalType ||
                    '',
                ).trim() || null
              : null,
          experienceYears:
            role === 'MEDIC'
              ? Number(
                  user.medicProfile?.experienceYears ??
                    extras.experienceYears ??
                    0,
                ) || 0
              : null,
          consultationFee:
            role === 'MEDIC' &&
            user.medicProfile?.consultationFee !== null &&
            user.medicProfile?.consultationFee !== undefined
              ? Number(user.medicProfile.consultationFee)
              : null,
          tenantId: tenant?.id || null,
          tenantName: tenant?.name || null,
          tenantType: tenant?.type || null,
          services:
            role === 'HOSPITAL_ADMIN'
              ? (() => {
                  const hospitalServices = tenant?.id
                    ? servicesByTenant.get(String(tenant.id)) || []
                    : [];
                  if (hospitalServices.length) return hospitalServices;
                  if (Array.isArray(extras.services) && extras.services.length) return extras.services;
                  if (Array.isArray(extras.specialties) && extras.specialties.length)
                    return extras.specialties;
                  return [];
                })()
              : Array.isArray(extras.services) && extras.services.length
                ? extras.services
                : Array.isArray(extras.specialties)
                  ? extras.specialties
                  : [],
          serviceDetails:
            role === 'HOSPITAL_ADMIN' && tenant?.id
              ? serviceDetailsByTenant.get(String(tenant.id)) || []
              : [],
        };
      })
      .filter(Boolean);
    const filteredItems = serviceFilter
      ? items.filter((item: any) => {
          if (item?.kind !== 'hospital') return false;
          const tenantId = String(item?.tenantId || '');
          const list = Array.isArray(item?.services) ? item.services : [];
          const tokens = tenantId ? serviceTokensByTenant.get(tenantId) || [] : [];
          const haystack = [...list, ...tokens];
          return haystack.some((entry: any) =>
            String(entry || '').toLowerCase().includes(serviceFilter),
          );
        })
      : items;

    return { items: filteredItems };
  }

  @Get(':id/location')
  async getUserLocation(@Req() req: any, @Param('id') id: string) {
    const viewerId = req.user?.userId;
    const viewerRole = req.user?.role;
    if (viewerId === id) {
      const extras = await getProfileExtras(this.prisma, id);
      return { location: extras.location || null };
    }

    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!target) return { location: null };

    if (viewerRole === 'SUPER_ADMIN') {
      const extras = await getProfileExtras(this.prisma, id);
      return { location: extras.location || null };
    }

    const orders = InMemoryStore.list('orders') as any[];
    const hires = InMemoryStore.list('medicHires') as any[];
    const hireMedics = hires.map((hire) => String(hire.medicId || '').trim()).filter(Boolean);
    const appointmentRows = await this.prisma.appointment.findMany({
      where: {
        OR: [
          { patientId: viewerId },
          { medicId: viewerId },
          { patientId: target.id },
          { medicId: target.id },
          ...(hireMedics.length ? [{ medicId: { in: hireMedics } }] : []),
        ],
      },
      select: { patientId: true, medicId: true },
    });

    const hasAppointment = (patientId: string, medicId: string) =>
      appointmentRows.some(
        (appt) => appt.patientId === patientId && appt.medicId === medicId,
      );

    const hasOrder = (patientId: string, pharmacyId: string) =>
      orders.some(
        (order) => order.patientId === patientId && order.pharmacyId === pharmacyId,
      );

    const hasHire = (medicId: string, hospitalAdminId: string) =>
      hires.some(
        (hire) => hire.medicId === medicId && hire.hospitalAdminId === hospitalAdminId,
      );

    let allowed = false;

    if (viewerRole === 'PATIENT') {
      if (target.role === 'MEDIC') {
        allowed = hasAppointment(viewerId, target.id);
      }
      if (target.role === 'PHARMACY_ADMIN') {
        allowed = hasOrder(viewerId, target.id);
      }
      if (target.role === 'HOSPITAL_ADMIN') {
        const linkedMedics = hires
          .filter((hire) => hire.hospitalAdminId === target.id)
          .map((hire) => hire.medicId);
        allowed = appointmentRows.some(
          (appt) => appt.patientId === viewerId && linkedMedics.includes(appt.medicId),
        );
      }
    }

    if (viewerRole === 'MEDIC') {
      if (target.role === 'PATIENT') {
        allowed = hasAppointment(target.id, viewerId);
      }
      if (target.role === 'HOSPITAL_ADMIN') {
        allowed = hasHire(viewerId, target.id);
      }
    }

    if (viewerRole === 'HOSPITAL_ADMIN') {
      if (target.role === 'MEDIC') {
        allowed = hasHire(target.id, viewerId);
      }
      if (target.role === 'PATIENT') {
        const linkedMedics = hires
          .filter((hire) => hire.hospitalAdminId === viewerId)
          .map((hire) => hire.medicId);
        allowed = appointmentRows.some(
          (appt) => appt.patientId === target.id && linkedMedics.includes(appt.medicId),
        );
      }
    }

    if (viewerRole === 'PHARMACY_ADMIN') {
      if (target.role === 'PATIENT') {
        allowed = hasOrder(target.id, viewerId);
      }
    }

    if (!allowed) {
      throw new ForbiddenException('Not allowed to view location');
    }

    const extras = await getProfileExtras(this.prisma, id);
    return { location: extras.location || null };
  }

  @Get('linked-locations')
  async getLinkedLocations(@Req() req: any) {
    const viewerId = req.user?.userId;
    const viewerRole = req.user?.role;

    const orders = InMemoryStore.list('orders') as any[];
    const hires = InMemoryStore.list('medicHires') as any[];
    const appointments =
      viewerRole === 'PATIENT'
        ? await this.prisma.appointment.findMany({
            where: { patientId: viewerId },
            select: { patientId: true, medicId: true },
          })
        : viewerRole === 'MEDIC'
          ? await this.prisma.appointment.findMany({
              where: { medicId: viewerId },
              select: { patientId: true, medicId: true },
            })
          : viewerRole === 'HOSPITAL_ADMIN'
            ? await this.prisma.appointment.findMany({
                where: {
                  medicId: {
                    in: hires
                      .filter((hire) => hire.hospitalAdminId === viewerId)
                      .map((hire) => hire.medicId)
                      .filter(Boolean),
                  },
                },
                select: { patientId: true, medicId: true },
              })
            : [];

    const linkedIds = new Set<string>();

    if (viewerRole === 'SUPER_ADMIN') {
      const users = await this.prisma.user.findMany({
        select: { id: true, fullName: true, email: true, phone: true, role: true },
      });
      const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
      return users.map((user) => {
        const extras = extrasMap.get(user.id) || {};
        return {
          id: user.id,
          name: user.fullName,
          email: user.email,
          phone: user.phone || null,
          role: user.role,
          location: extras.location || null,
        };
      });
    }

    if (viewerRole === 'PATIENT') {
      appointments
        .filter((appt) => appt.patientId === viewerId)
        .forEach((appt) => {
          if (appt.medicId) linkedIds.add(appt.medicId);
        });
      orders
        .filter((order) => order.patientId === viewerId)
        .forEach((order) => linkedIds.add(order.pharmacyId));
      const linkedMedics = hires.map((hire) => hire.medicId);
      appointments
        .filter(
          (appt) => appt.patientId === viewerId && linkedMedics.includes(appt.medicId),
        )
        .forEach((appt) => {
          const hire = hires.find((h) => h.medicId === appt.medicId);
          if (hire?.hospitalAdminId) linkedIds.add(hire.hospitalAdminId);
        });
    }

    if (viewerRole === 'MEDIC') {
      appointments
        .filter((appt) => appt.medicId === viewerId)
        .forEach((appt) => linkedIds.add(appt.patientId));
      hires
        .filter((hire) => hire.medicId === viewerId)
        .forEach((hire) => linkedIds.add(hire.hospitalAdminId));
    }

    if (viewerRole === 'HOSPITAL_ADMIN') {
      hires
        .filter((hire) => hire.hospitalAdminId === viewerId)
        .forEach((hire) => linkedIds.add(hire.medicId));
      const myMedics = hires
        .filter((hire) => hire.hospitalAdminId === viewerId)
        .map((hire) => hire.medicId);
      appointments
        .filter((appt) => myMedics.includes(appt.medicId))
        .forEach((appt) => linkedIds.add(appt.patientId));
    }

    if (viewerRole === 'PHARMACY_ADMIN') {
      orders
        .filter((order) => order.pharmacyId === viewerId)
        .forEach((order) => linkedIds.add(order.patientId));
    }

    const ids = Array.from(linkedIds).filter(Boolean);
    if (ids.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, email: true, phone: true, role: true },
    });
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));

    return users.map((user) => {
      const extras = extrasMap.get(user.id) || {};
      return {
        id: user.id,
        name: user.fullName,
        email: user.email,
        phone: user.phone || null,
        role: user.role,
        location: extras.location || null,
      };
    });
  }
}
