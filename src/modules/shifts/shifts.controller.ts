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
} from 'src/common/profile-validation';
import { getProfileExtras } from 'src/common/profile-extras';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { PushService } from 'src/common/push.service';
import { EmailsService } from '../emails/emails.service';

@Controller('shifts')
@UseGuards(AuthGuard('jwt'))
export class ShiftsController {
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

  private parseBoolean(value: any, fallback = false) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
  }

  private parseList(value: any) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  }

  private async enrichApplications(items: any[]) {
    const medicIds = Array.from(
      new Set(
        items.flatMap((item) =>
          (Array.isArray(item?.applications) ? item.applications : [])
            .map((app: any) => String(app?.medicId || '').trim())
            .filter(Boolean),
        ),
      ),
    );
    if (!medicIds.length) return items;
    const users = await this.prisma.user.findMany({
      where: { id: { in: medicIds } },
      select: { id: true, fullName: true, email: true },
    });
    const byId = new Map(users.map((user) => [String(user.id), user]));
    return items.map((item) => {
      const applications = Array.isArray(item?.applications) ? item.applications : [];
      const enriched = applications.map((app: any) => {
        const medicId = String(app?.medicId || '');
        const user = byId.get(medicId);
        return {
          ...app,
          medicName: user?.fullName || null,
          medicEmail: user?.email || null,
        };
      });
      return { ...item, applications: enriched };
    });
  }

  private parseTimeToMinutes(value?: string | null) {
    if (!value) return null;
    const raw = String(value).trim().toLowerCase();
    const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) return null;
    let hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const meridiem = match[3];
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    if (minutes < 0 || minutes > 59) return null;
    if (meridiem) {
      if (hours === 12) hours = 0;
      if (meridiem === 'pm') hours += 12;
    }
    if (hours < 0 || hours > 23) return null;
    return hours * 60 + minutes;
  }

  private minutesToTime(minutes: number) {
    const safe = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
    const hours = Math.floor(safe / 60);
    const mins = safe % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  private parseDate(value?: string | null) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  private formatDate(value: Date) {
    return value.toISOString().slice(0, 10);
  }

  private addDays(value: Date, days: number) {
    const next = new Date(value);
    next.setDate(next.getDate() + days);
    return next;
  }

  private normalizeRepeatDays(values: any[]) {
    const map: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    return values
      .map((value) => String(value || '').trim().toLowerCase())
      .map((value) => map[value])
      .filter((value) => typeof value === 'number') as number[];
  }

  private generateRecurringDates(input: {
    shiftDate?: string | null;
    repeatInterval?: string | null;
    repeatDays?: any[];
    horizonDays?: number;
  }) {
    const baseDate = this.parseDate(input.shiftDate);
    if (!baseDate) return [];
    const interval = String(input.repeatInterval || '').trim().toUpperCase();
    if (!interval || interval === 'NONE') return [];
    const horizonDays = Math.max(1, this.normalizeNumber(input.horizonDays, 28));
    const endDate = this.addDays(baseDate, horizonDays);
    const repeatDayIndexes = this.normalizeRepeatDays(input.repeatDays || []);
    const results: string[] = [];
    for (let cursor = this.addDays(baseDate, 1); cursor <= endDate; cursor = this.addDays(cursor, 1)) {
      if (interval === 'DAILY') {
        results.push(this.formatDate(cursor));
        continue;
      }
      if (interval === 'WEEKLY') {
        if (repeatDayIndexes.length === 0) continue;
        if (repeatDayIndexes.includes(cursor.getDay())) {
          results.push(this.formatDate(cursor));
        }
        continue;
      }
      if (interval === 'MONTHLY') {
        if (cursor.getDate() === baseDate.getDate()) {
          results.push(this.formatDate(cursor));
        }
      }
    }
    return results;
  }

  private generateSlots(input: {
    startTime?: string | null;
    endTime?: string | null;
    consultationDuration?: number | null;
    bufferMinutes?: number | null;
    breakMinutes?: number | null;
    maxPatients?: number | null;
  }) {
    const start = this.parseTimeToMinutes(input.startTime);
    const end = this.parseTimeToMinutes(input.endTime);
    const duration = this.normalizeNumber(input.consultationDuration, 0);
    if (start === null || end === null || duration <= 0 || end <= start) return [];
    const buffer = Math.max(0, this.normalizeNumber(input.bufferMinutes, 0));
    const breakMinutes = Math.max(0, this.normalizeNumber(input.breakMinutes, 0));
    const maxPatients = Math.max(0, this.normalizeNumber(input.maxPatients, 0));

    let effectiveEnd = end;
    if (breakMinutes > 0 && end - start > breakMinutes) {
      effectiveEnd = end - breakMinutes;
    }

    const slots: Array<{ start: string; end: string }> = [];
    for (let cursor = start; cursor + duration <= effectiveEnd; cursor += duration + buffer) {
      slots.push({
        start: this.minutesToTime(cursor),
        end: this.minutesToTime(cursor + duration),
      });
      if (maxPatients > 0 && slots.length >= maxPatients) break;
    }
    return slots;
  }

  private hasTimeOverlap(aStart: string | null, aEnd: string | null, bStart: number, bEnd: number) {
    const start = this.parseTimeToMinutes(aStart);
    const end = this.parseTimeToMinutes(aEnd);
    if (start === null || end === null) return false;
    return start < bEnd && end > bStart;
  }

  private normalizeOpportunityType(value: any, fallback: 'SHIFT' | 'JOB' = 'SHIFT') {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'JOB' || normalized === 'SHIFT') return normalized as 'SHIFT' | 'JOB';
    return fallback;
  }

  private parseJobDetails(value: any): Record<string, any> | null {
    if (!value) return null;
    if (typeof value === 'object') return value as Record<string, any>;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  private sanitizeText(value: any) {
    const text = String(value ?? '').trim();
    return text.length ? text : null;
  }

  private buildJobDetails(body: any, base: Record<string, any> = {}) {
    return {
      opportunityType:
        this.sanitizeText(body?.opportunityType) ??
        base.opportunityType ??
        'SHIFT',
      requirements:
        this.sanitizeText(body?.requirements ?? body?.specifications) ??
        base.requirements ??
        null,
      department: this.sanitizeText(body?.department) ?? base.department ?? null,
      jobType: this.sanitizeText(body?.jobType) ?? base.jobType ?? null,
      scheduleType: this.sanitizeText(body?.scheduleType) ?? base.scheduleType ?? null,
      shiftPattern: this.sanitizeText(body?.shiftPattern) ?? base.shiftPattern ?? null,
      experienceLevel: this.sanitizeText(body?.experienceLevel) ?? base.experienceLevel ?? null,
      startDate: this.sanitizeText(body?.startDate) ?? base.startDate ?? null,
      applicationDeadline:
        this.sanitizeText(body?.applicationDeadline) ?? base.applicationDeadline ?? null,
      responsibilities:
        this.sanitizeText(body?.responsibilities) ?? base.responsibilities ?? null,
      qualifications: this.sanitizeText(body?.qualifications) ?? base.qualifications ?? null,
      benefits: this.sanitizeText(body?.benefits) ?? base.benefits ?? null,
      contactEmail: this.sanitizeText(body?.contactEmail) ?? base.contactEmail ?? null,
      contactPhone: this.sanitizeText(body?.contactPhone) ?? base.contactPhone ?? null,
    };
  }

  private serializeJobDetails(details: Record<string, any>) {
    const compact = Object.fromEntries(
      Object.entries(details || {}).filter(([, value]) => value !== null && value !== undefined && `${value}`.trim() !== ''),
    );
    return JSON.stringify(compact);
  }

  private collectMissingJobFields(input: {
    title?: any;
    description?: any;
    specialization?: any;
    location?: any;
    requiredMedics?: any;
    hours?: any;
    details?: Record<string, any>;
  }) {
    const details = input.details || {};
    const requiredTextFields: Array<{ key: string; label: string; value: any }> = [
      { key: 'title', label: 'Job title', value: input.title },
      { key: 'description', label: 'Job summary', value: input.description },
      { key: 'department', label: 'Department', value: details.department },
      { key: 'specialization', label: 'Specialization', value: input.specialization },
      { key: 'jobType', label: 'Job type', value: details.jobType },
      { key: 'scheduleType', label: 'Schedule type', value: details.scheduleType },
      { key: 'shiftPattern', label: 'Shift pattern', value: details.shiftPattern },
      { key: 'experienceLevel', label: 'Experience level', value: details.experienceLevel },
      { key: 'responsibilities', label: 'Responsibilities', value: details.responsibilities },
      { key: 'qualifications', label: 'Qualifications', value: details.qualifications },
      { key: 'requirements', label: 'Requirements', value: details.requirements },
      { key: 'benefits', label: 'Benefits', value: details.benefits },
      { key: 'contactEmail', label: 'Contact email', value: details.contactEmail },
      { key: 'contactPhone', label: 'Contact phone', value: details.contactPhone },
      { key: 'applicationDeadline', label: 'Application deadline', value: details.applicationDeadline },
      { key: 'startDate', label: 'Start date', value: details.startDate },
      { key: 'location', label: 'Location', value: input.location },
    ];
    const missingText = requiredTextFields
      .filter((field) => !this.sanitizeText(field.value))
      .map((field) => field.label);

    const requiredCountFields: Array<{ label: string; value: any }> = [
      { label: 'Required medics', value: input.requiredMedics },
      { label: 'Working hours', value: input.hours },
    ];
    const missingCounts = requiredCountFields
      .filter((field) => this.normalizeNumber(field.value, 0) <= 0)
      .map((field) => field.label);

    return [...missingText, ...missingCounts];
  }

  private ensureJobFieldsComplete(input: {
    title?: any;
    description?: any;
    specialization?: any;
    location?: any;
    requiredMedics?: any;
    hours?: any;
    details?: Record<string, any>;
  }) {
    const missingFields = this.collectMissingJobFields(input);
    if (missingFields.length) {
      throw new BadRequestException({
        message: 'Job details incomplete',
        missingFields,
      });
    }
  }

  @Get('analytics/hospital')
  async hospitalAnalytics(@Req() req: any) {
    const userId = req.user?.userId;
    const role = String(req.user?.role || '').toUpperCase();
    if (!userId || role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only hospital admins can view this analytics.');
    }

    const shifts = await this.db.shift.findMany({
      where: { createdBy: userId },
      orderBy: { createdAt: 'desc' },
    });
    const shiftIds = shifts.map((shift: any) => shift.id);
    const applicationsCount = shifts.reduce((sum: number, shift: any) => {
      const apps = Array.isArray(shift?.applications) ? shift.applications : [];
      return sum + apps.length;
    }, 0);

    const shiftsCreated = shifts.length;
    const shiftsCancelled = shifts.filter((shift: any) =>
      ['CANCELLED', 'CANCELED'].includes(String(shift?.status || '').toUpperCase()),
    ).length;
    const shiftsCompleted = shifts.filter(
      (shift: any) => String(shift?.status || '').toUpperCase() === 'COMPLETED',
    ).length;
    const totalShiftHours = shifts.reduce((sum: number, shift: any) => {
      const hours = this.normalizeNumber(shift?.hours, 0);
      const requiredMedics = Math.max(1, this.normalizeNumber(shift?.requiredMedics, 1));
      return sum + hours * requiredMedics;
    }, 0);
    const completedShiftHours = shifts.reduce((sum: number, shift: any) => {
      const isCompleted = String(shift?.status || '').toUpperCase() === 'COMPLETED';
      if (!isCompleted) return sum;
      const hours = this.normalizeNumber(shift?.hours, 0);
      const requiredMedics = Math.max(1, this.normalizeNumber(shift?.requiredMedics, 1));
      return sum + hours * requiredMedics;
    }, 0);
    const hoursRemaining = Math.max(totalShiftHours - completedShiftHours, 0);

    const hires = (InMemoryStore.list('medicHires') as any[]).filter(
      (hire) => hire?.hospitalAdminId === userId,
    );
    const hiredCount = hires.length;

    const payments = (InMemoryStore.list('payments') as any[]).filter(
      (payment) =>
        payment?.userId === userId &&
        String(payment?.recipientRole || '').toUpperCase() === 'MEDIC',
    );
    const paidStatuses = new Set(['PAID', 'COMPLETED', 'APPROVED']);
    const pendingStatuses = new Set(['PENDING', 'PROCESSING']);
    const amountPaid = payments
      .filter((payment) => paidStatuses.has(String(payment?.status || '').toUpperCase()))
      .reduce((sum, payment) => sum + this.normalizeNumber(payment?.amount, 0), 0);
    const pendingPayments = payments.filter((payment) =>
      pendingStatuses.has(String(payment?.status || '').toUpperCase()),
    );
    const pendingPaymentsCount = pendingPayments.length;
    const pendingAmount = pendingPayments.reduce(
      (sum, payment) => sum + this.normalizeNumber(payment?.amount, 0),
      0,
    );
    const totalAmountToPay = amountPaid + pendingAmount;

    const tenantLinks = await this.prisma.tenantUser.findMany({
      where: { userId, tenant: { type: 'HOSPITAL' } },
      select: { tenantId: true },
    });
    const tenantIds = Array.from(new Set(tenantLinks.map((link) => link.tenantId).filter(Boolean)));

    const products = tenantIds.length
      ? await this.db.product.findMany({ where: { pharmacyId: { in: tenantIds } } })
      : [];
    const totalProducts = products.length;

    const soldMovements = tenantIds.length
      ? await this.db.stockMovement.findMany({
          where: {
            pharmacyId: { in: tenantIds },
            OR: [{ type: 'SALE' }, { quantityChange: { lt: 0 } }],
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const soldProductsCount = soldMovements.reduce(
      (sum: number, movement: any) => sum + Math.abs(this.normalizeNumber(movement?.quantityChange, 0)),
      0,
    );
    const priceByProductId: Map<string, number> = new Map(
      products.map((product: any) => [String(product.id), this.normalizeNumber(product.price, 0)]),
    );
    const nameByProductId = new Map(
      products.map((product: any) => [String(product.id), product.name || product.productName || product.id]),
    );
    const salesRevenue = soldMovements.reduce((sum: number, movement: any) => {
      const productId = String(movement?.productId || '');
      const quantity = Math.abs(this.normalizeNumber(movement?.quantityChange, 0));
      const unitPrice = Number(priceByProductId.get(productId) || 0);
      return sum + unitPrice * quantity;
    }, 0);
    const soldByProduct = soldMovements.reduce((acc: Record<string, number>, movement: any) => {
      const key = String(movement?.productId || movement?.productName || '').trim();
      if (!key) return acc;
      const quantity = Math.abs(this.normalizeNumber(movement?.quantityChange, 0));
      acc[key] = (acc[key] || 0) + quantity;
      return acc;
    }, {});
    const topBoughtProducts = Object.entries(soldByProduct)
      .map(([key, quantity]) => ({
        productId: key,
        productName: nameByProductId.get(key) || key,
        quantity,
      }))
      .sort((a, b) => Number(b.quantity) - Number(a.quantity))
      .slice(0, 8);

    return {
      totals: {
        shiftsCreated,
        shiftsCancelled,
        shiftsCompleted,
        appliedShifts: applicationsCount,
        hiredMedics: hiredCount,
        amountPaid,
        pendingPayments: pendingPaymentsCount,
        pendingAmount,
        totalAmountToPay,
        totalShiftHours,
        completedShiftHours,
        hoursRemaining,
        totalProducts,
        soldProducts: soldProductsCount,
        salesRevenue,
      },
      charts: {
        shiftStatus: [
          { label: 'Created', value: shiftsCreated },
          { label: 'Completed', value: shiftsCompleted },
          { label: 'Cancelled', value: shiftsCancelled },
        ],
        payments: [
          { label: 'Paid', value: amountPaid },
          { label: 'Pending', value: pendingAmount },
        ],
      },
      topBoughtProducts,
      context: {
        shiftIds,
        tenantIds,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get()
  async list(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('location') location?: string,
    @Query('specialization') specialization?: string,
    @Query('hospital') hospital?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
    @Query('opportunityType') opportunityType?: string,
  ) {
    const role = String(req.user?.role || '').toUpperCase();
    const mineOnly = String(mine || '').toLowerCase() === 'true' || mine === '1';
    const currentUserId = req.user?.userId;
    const where: any = {};

    if (role !== 'MEDIC') {
      if (role === 'HOSPITAL_ADMIN' || role === 'SUPER_ADMIN') {
        if (!mineOnly) return [];
      } else {
        return [];
      }
    }

    if (mineOnly && currentUserId) {
      where.createdBy = currentUserId;
    }
    if (status) {
      where.status = String(status || '').toUpperCase();
    } else if (!mineOnly) {
      where.status = { notIn: ['CANCELLED', 'CLOSED'] };
    }
    if (search) {
      const searchText = String(search).trim();
      const searchNumber = this.normalizeNumber(searchText, Number.NaN);
      const orFilters: any[] = [
        { title: { contains: searchText, mode: 'insensitive' } },
        { description: { contains: searchText, mode: 'insensitive' } },
        { hospitalName: { contains: searchText, mode: 'insensitive' } },
        { location: { contains: searchText, mode: 'insensitive' } },
        { specialization: { contains: searchText, mode: 'insensitive' } },
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
    if (hospital) {
      where.hospitalName = { contains: hospital, mode: 'insensitive' };
    }

    const rawType = String(opportunityType || '').trim().toUpperCase();
    if (rawType === 'JOB') {
      return [];
    }

    const items = await this.db.shift.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    return mineOnly ? this.enrichApplications(items) : items;
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId;
    const role = String(req.user?.role || '').toUpperCase();
    if (!userId || role !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only hospital admins can create shifts.');
    }

    const requestedType = String(body?.opportunityType || '').trim().toUpperCase();
    if (requestedType === 'JOB') {
      throw new BadRequestException('Jobs must be created using /jobs.');
    }
    await ensureHospitalProfileComplete(this.prisma, userId);

    const extras = await getProfileExtras(this.prisma, userId);
    const employerName =
      extras.hospitalName ||
      body.hospitalName ||
      null;
    const employerLocation =
      extras.locationAddress ||
      extras.location?.address ||
      extras.location ||
      extras.address ||
      body.location ||
      body.area ||
      null;
    const shiftRequirements =
      this.sanitizeText(body?.requirements ?? body?.specifications) ?? null;
    const shiftDate = this.sanitizeText(body?.shiftDate ?? body?.date);
    const startTime = this.sanitizeText(body?.startTime);
    const endTime = this.sanitizeText(body?.endTime);
    const shiftType = this.sanitizeText(body?.shiftType);
    const department = this.sanitizeText(body?.department);
    const doctorId = this.sanitizeText(body?.doctorId ?? body?.medicId);
    const hospitalId = this.sanitizeText(body?.hospitalId) ?? userId;
    const consultationDuration = this.normalizeNumber(body?.consultationDuration, 0);
    const maxPatients = this.normalizeNumber(body?.maxPatients, 0);
    const breakMinutes = this.normalizeNumber(body?.breakMinutes, 0);
    const bufferMinutes = this.normalizeNumber(body?.bufferMinutes, 0);
    const hospitalBranch = this.sanitizeText(body?.hospitalBranch);
    const roomNumber = this.sanitizeText(body?.roomNumber);
    const consultationTypes = this.parseList(body?.consultationTypes);
    const isAvailable = this.parseBoolean(body?.isAvailable, true);
    const walkInAllowed = this.parseBoolean(body?.walkInAllowed, false);
    const emergencySlotReserved = this.parseBoolean(body?.emergencySlotReserved, false);
    const repeatInterval =
      this.sanitizeText(body?.repeatInterval ?? body?.repeat) ?? null;
    const repeatDays = this.parseList(body?.repeatDays);

    const startMinutes = this.parseTimeToMinutes(startTime);
    const endMinutes = this.parseTimeToMinutes(endTime);
    const computedHours =
      startMinutes !== null && endMinutes !== null && endMinutes > startMinutes
        ? Math.round(((endMinutes - startMinutes) / 60) * 100) / 100
        : this.normalizeNumber(body?.hours, 0);
    if (doctorId && shiftDate && startMinutes !== null && endMinutes !== null) {
      const existingShifts = await this.db.shift.findMany({
        where: {
          doctorId,
          shiftDate,
          status: { notIn: ['CANCELLED', 'CANCELED'] },
        },
      });
      const overlaps = existingShifts.some((existing: any) =>
        this.hasTimeOverlap(existing?.startTime || null, existing?.endTime || null, startMinutes, endMinutes),
      );
      if (overlaps) {
        throw new BadRequestException('Shift time conflicts with an existing doctor schedule.');
      }
    }

    const payload: any = {
      title: body.title || body.task,
      description: body.description || body.summary || null,
      specifications: shiftRequirements,
      specialization: body.specialization || body.category || null,
      department,
      doctorId,
      hospitalId,
      shiftDate,
      startTime,
      endTime,
      shiftType,
      consultationDuration,
      maxPatients,
      breakMinutes,
      bufferMinutes,
      hospitalBranch,
      roomNumber,
      consultationTypes: consultationTypes.length ? consultationTypes : null,
      isAvailable,
      walkInAllowed,
      emergencySlotReserved,
      repeatInterval,
      repeatDays: repeatDays.length ? repeatDays : null,
      requiredMedics: Number(body.requiredMedics || body.medicsRequired || 0),
      hours: Number(computedHours || 0),
      payType: body.payType,
      payAmount: Number(body.payAmount || 0),
      status: 'OPEN',
      createdBy: userId,
      hospitalName: employerName,
      location: employerLocation,
      applications: [],
      slots: this.generateSlots({
        startTime,
        endTime,
        consultationDuration,
        bufferMinutes,
        breakMinutes,
        maxPatients,
      }),
    };

    if (!this.sanitizeText(payload.title)) {
      throw new BadRequestException({
        message: 'Shift details incomplete',
        missingFields: ['Shift title'],
      });
    }
    const missingFields: string[] = [];
    if (!this.sanitizeText(payload.department)) missingFields.push('Department');
    if (!this.sanitizeText(payload.specialization)) missingFields.push('Specialty');
    if (!this.sanitizeText(payload.shiftDate)) missingFields.push('Shift date');
    if (!this.sanitizeText(payload.startTime)) missingFields.push('Start time');
    if (!this.sanitizeText(payload.endTime)) missingFields.push('End time');
    if (!this.sanitizeText(payload.shiftType)) missingFields.push('Shift type');
    if (this.normalizeNumber(payload.consultationDuration, 0) <= 0) missingFields.push('Consultation duration');
    if (this.normalizeNumber(payload.maxPatients, 0) <= 0) missingFields.push('Max patients');
    if (this.normalizeNumber(payload.requiredMedics, 0) <= 0 || this.normalizeNumber(payload.hours, 0) <= 0) {
      missingFields.push('Required medics', 'Working hours');
    }
    if (missingFields.length) {
      throw new BadRequestException({
        message: 'Shift details incomplete',
        missingFields,
      });
    }
    const createdShift = await this.db.shift.create({ data: payload });
    const recurringDates = this.generateRecurringDates({
      shiftDate,
      repeatInterval,
      repeatDays,
      horizonDays: 28,
    });
    if (recurringDates.length) {
      const baseSlots = payload.slots || [];
      const batch: any[] = [];
      for (const date of recurringDates) {
        if (doctorId && startMinutes !== null && endMinutes !== null) {
          const existingShifts = await this.db.shift.findMany({
            where: {
              doctorId,
              shiftDate: date,
              status: { notIn: ['CANCELLED', 'CANCELED'] },
            },
          });
          const overlaps = existingShifts.some((existing: any) =>
            this.hasTimeOverlap(existing?.startTime || null, existing?.endTime || null, startMinutes, endMinutes),
          );
          if (overlaps) {
            continue;
          }
        }
        const exists = await this.db.shift.findFirst({
          where: {
            createdBy: userId,
            shiftDate: date,
            startTime,
            endTime,
            ...(doctorId ? { doctorId } : {}),
          },
        });
        if (exists) continue;
        batch.push({
          ...payload,
          shiftDate: date,
          applications: [],
          slots: baseSlots,
        });
      }
      if (batch.length) {
        await this.db.shift.createMany({ data: batch });
      }
    }
    return createdShift;
  }

  @Post(':id/apply')
  async apply(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can apply to shifts.');
    }

    const shift = await this.db.shift.findUnique({ where: { id } });
    if (!shift) return { success: false };
    if (['CANCELLED', 'CLOSED'].includes(String(shift?.status || '').toUpperCase())) {
      throw new BadRequestException('This shift is no longer accepting applications.');
    }

    const userId = req.user?.userId;
    await ensureMedicProfileComplete(this.prisma, userId);

    const applications = Array.isArray(shift.applications) ? shift.applications : [];
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
    await this.db.shift.update({
      where: { id },
      data: { applications: nextApplications },
    });
    return {
      success: true,
      application: nextApplications[nextApplications.length - 1],
    };
  }

  @Put(':id/applications/:medicId/approve')
  async approveApplication(
    @Req() req: any,
    @Param('id') id: string,
    @Param('medicId') medicId: string,
  ) {
    const shift = (await this.db.shift.findUnique({ where: { id } })) as any;
    if (!shift) throw new NotFoundException('Shift not found.');
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (shift.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to approve this application.');
    }

    const applications = Array.isArray(shift.applications) ? shift.applications : [];
    const nextApplications = applications.map((app: any) => {
      if (String(app?.medicId || '') !== String(medicId || '')) return app;
      return { ...app, status: 'APPROVED', reviewedAt: new Date().toISOString() };
    });
    const target = Number(shift.requiredMedics || 0);
    const approvedCount = nextApplications.filter(
      (app: any) => String(app?.status || '').toUpperCase() === 'APPROVED',
    ).length;
    const nextStatus = target > 0 && approvedCount >= target ? 'CLOSED' : shift.status;
    const updated = await this.db.shift.update({
      where: { id },
      data: {
        applications: nextApplications,
        status: nextStatus,
      },
    });
    return updated;
  }

  @Put(':id/applications/:medicId/reject')
  async rejectApplication(
    @Req() req: any,
    @Param('id') id: string,
    @Param('medicId') medicId: string,
  ) {
    const shift = (await this.db.shift.findUnique({ where: { id } })) as any;
    if (!shift) throw new NotFoundException('Shift not found.');
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (shift.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to reject this application.');
    }

    const applications = Array.isArray(shift.applications) ? shift.applications : [];
    const nextApplications = applications.map((app: any) => {
      if (String(app?.medicId || '') !== String(medicId || '')) return app;
      return { ...app, status: 'REJECTED', reviewedAt: new Date().toISOString() };
    });
    const updated = await this.db.shift.update({
      where: { id },
      data: { applications: nextApplications },
    });
    return updated;
  }

  @Post(':id/unapply')
  async unapply(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can cancel shift applications.');
    }

    const shift = await this.db.shift.findUnique({ where: { id } });
    if (!shift) throw new NotFoundException('Shift not found.');

    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('Not allowed to cancel this application.');
    }

    const applications = Array.isArray(shift.applications) ? shift.applications : [];
    const existing = applications.find((item: any) => item?.medicId === userId);
    if (!existing) {
      return { success: true, notApplied: true };
    }

    const nextApplications = applications.filter((item: any) => item?.medicId !== userId);
    await this.db.shift.update({
      where: { id },
      data: { applications: nextApplications },
    });

    if (shift?.createdBy && shift.createdBy !== userId) {
      const title = 'Shift application cancelled';
      const message = `A medic cancelled their application for ${
        shift?.title || 'a shift'
      }.`;

      InMemoryStore.create('notifications', {
        userId: shift.createdBy,
        title,
        message,
        type: 'SHIFT_APPLICATION_WITHDRAWN',
        relatedId: shift.id,
        data: {
          shiftId: shift.id,
          medicId: userId,
          status: 'WITHDRAWN',
        },
        isRead: false,
        createdAt: new Date().toISOString(),
      });

      this.notificationsGateway.emitToUser(shift.createdBy, {
        title,
        message,
        type: 'SHIFT_APPLICATION_WITHDRAWN',
        data: {
          shiftId: shift.id,
          medicId: userId,
          status: 'WITHDRAWN',
        },
      });
    }

    return { success: true, cancelled: true };
  }

  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const shift = (await this.db.shift.findUnique({ where: { id } })) as any;
    if (!shift) throw new NotFoundException('Shift not found.');
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (shift.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to edit this shift.');
    }

    const requestedType = String(body?.opportunityType || '').trim().toUpperCase();
    if (requestedType === 'JOB') {
      throw new BadRequestException('Jobs must be edited using /jobs/:id.');
    }
    const shiftRequirements =
      this.sanitizeText(body?.requirements ?? body?.specifications) ??
      this.sanitizeText(shift?.specifications) ??
      null;

    const nextTitle = body.title ?? body.task ?? shift.title;
    const nextDescription = body.description ?? body.summary ?? shift.description;
    const nextSpecialization =
      body.specialization ?? body.category ?? body.department ?? shift.specialization;
    const nextDepartment = body.department ?? shift.department;
    const nextDoctorId = body.doctorId ?? body.medicId ?? shift.doctorId;
    const nextHospitalId = body.hospitalId ?? shift.hospitalId;
    const nextShiftDate = body.shiftDate ?? body.date ?? shift.shiftDate;
    const nextStartTime = body.startTime ?? shift.startTime;
    const nextEndTime = body.endTime ?? shift.endTime;
    const nextShiftType = body.shiftType ?? shift.shiftType;
    const nextConsultationDuration = body.consultationDuration ?? shift.consultationDuration;
    const nextMaxPatients = body.maxPatients ?? shift.maxPatients;
    const nextBreakMinutes = body.breakMinutes ?? shift.breakMinutes;
    const nextBufferMinutes = body.bufferMinutes ?? shift.bufferMinutes;
    const nextHospitalBranch = body.hospitalBranch ?? shift.hospitalBranch;
    const nextRoomNumber = body.roomNumber ?? shift.roomNumber;
    const nextConsultationTypes = body.consultationTypes ?? shift.consultationTypes;
    const nextIsAvailable = body.isAvailable ?? shift.isAvailable;
    const nextWalkInAllowed = body.walkInAllowed ?? shift.walkInAllowed;
    const nextEmergencySlotReserved = body.emergencySlotReserved ?? shift.emergencySlotReserved;
    const nextRepeatInterval = body.repeatInterval ?? body.repeat ?? shift.repeatInterval;
    const nextRepeatDays = body.repeatDays ?? shift.repeatDays;
    const nextRequiredMedics = body.requiredMedics ?? body.medicsRequired ?? shift.requiredMedics;
    const nextLocation = body.location ?? shift.location;

    const startMinutes = this.parseTimeToMinutes(nextStartTime);
    const endMinutes = this.parseTimeToMinutes(nextEndTime);
    const computedHours =
      startMinutes !== null && endMinutes !== null && endMinutes > startMinutes
        ? Math.round(((endMinutes - startMinutes) / 60) * 100) / 100
        : this.normalizeNumber(body?.hours ?? shift.hours, 0);
    if (nextDoctorId && nextShiftDate && startMinutes !== null && endMinutes !== null) {
      const existingShifts = await this.db.shift.findMany({
        where: {
          doctorId: nextDoctorId,
          shiftDate: nextShiftDate,
          status: { notIn: ['CANCELLED', 'CANCELED'] },
          NOT: { id },
        },
      });
      const overlaps = existingShifts.some((existing: any) =>
        this.hasTimeOverlap(existing?.startTime || null, existing?.endTime || null, startMinutes, endMinutes),
      );
      if (overlaps) {
        throw new BadRequestException('Shift time conflicts with an existing doctor schedule.');
      }
    }

    if (!this.sanitizeText(nextTitle)) {
      throw new BadRequestException({
        message: 'Shift details incomplete',
        missingFields: ['Shift title'],
      });
    }
    const missingFields: string[] = [];
    if (!this.sanitizeText(nextDepartment)) missingFields.push('Department');
    if (!this.sanitizeText(nextSpecialization)) missingFields.push('Specialty');
    if (!this.sanitizeText(nextShiftDate)) missingFields.push('Shift date');
    if (!this.sanitizeText(nextStartTime)) missingFields.push('Start time');
    if (!this.sanitizeText(nextEndTime)) missingFields.push('End time');
    if (!this.sanitizeText(nextShiftType)) missingFields.push('Shift type');
    if (this.normalizeNumber(nextConsultationDuration, 0) <= 0) missingFields.push('Consultation duration');
    if (this.normalizeNumber(nextMaxPatients, 0) <= 0) missingFields.push('Max patients');
    if (this.normalizeNumber(nextRequiredMedics, 0) <= 0 || this.normalizeNumber(computedHours, 0) <= 0) {
      missingFields.push('Required medics', 'Working hours');
    }
    if (missingFields.length) {
      throw new BadRequestException({
        message: 'Shift details incomplete',
        missingFields,
      });
    }

    const updated = await this.db.shift.update({
      where: { id },
      data: {
        title: nextTitle,
        description: nextDescription,
        specifications: shiftRequirements,
        specialization: nextSpecialization,
        department: nextDepartment,
        doctorId: nextDoctorId,
        hospitalId: nextHospitalId,
        shiftDate: nextShiftDate,
        startTime: nextStartTime,
        endTime: nextEndTime,
        shiftType: nextShiftType,
        consultationDuration: this.normalizeNumber(nextConsultationDuration, 0),
        maxPatients: this.normalizeNumber(nextMaxPatients, 0),
        breakMinutes: this.normalizeNumber(nextBreakMinutes, 0),
        bufferMinutes: this.normalizeNumber(nextBufferMinutes, 0),
        hospitalBranch: this.sanitizeText(nextHospitalBranch),
        roomNumber: this.sanitizeText(nextRoomNumber),
        consultationTypes: Array.isArray(nextConsultationTypes)
          ? nextConsultationTypes
          : this.parseList(nextConsultationTypes),
        isAvailable: this.parseBoolean(nextIsAvailable, true),
        walkInAllowed: this.parseBoolean(nextWalkInAllowed, false),
        emergencySlotReserved: this.parseBoolean(nextEmergencySlotReserved, false),
        repeatInterval: this.sanitizeText(nextRepeatInterval),
        repeatDays: Array.isArray(nextRepeatDays) ? nextRepeatDays : this.parseList(nextRepeatDays),
        requiredMedics: nextRequiredMedics,
        hours: computedHours || 0,
        payType: body.payType ?? shift.payType,
        payAmount: body.payAmount ?? shift.payAmount,
        location: nextLocation,
        status: body.status ?? shift.status,
        slots: this.generateSlots({
          startTime: nextStartTime,
          endTime: nextEndTime,
          consultationDuration: this.normalizeNumber(nextConsultationDuration, 0),
          bufferMinutes: this.normalizeNumber(nextBufferMinutes, 0),
          breakMinutes: this.normalizeNumber(nextBreakMinutes, 0),
          maxPatients: this.normalizeNumber(nextMaxPatients, 0),
        }),
      },
    });
    return updated;
  }

  @Put(':id/cancel')
  async cancel(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const shift = (await this.db.shift.findUnique({ where: { id } })) as any;
    if (!shift) throw new NotFoundException('Shift not found.');
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (shift.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to cancel this shift.');
    }

    const cancelled = await this.db.shift.update({
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
    const shift = (await this.db.shift.findUnique({ where: { id } })) as any;
    if (!shift) throw new NotFoundException('Shift not found.');
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    if (shift.createdBy !== userId && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not allowed to delete this shift.');
    }

    await this.db.shift.delete({ where: { id } });
    return { success: true };
  }

  private async notifyAppliedMedicsOfCancellation(shift: any) {
    const applications = Array.isArray(shift?.applications) ? shift.applications : [];
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
        const title = 'Shift Cancelled';
        const message = `${shift?.title || 'A shift'} at ${
          shift?.hospitalName || 'the hospital'
        } was cancelled.`;

        InMemoryStore.create('notifications', {
          userId: medicId,
          title,
          message,
          type: 'SHIFT_CANCELLED',
          relatedId: shift?.id,
          data: { shiftId: shift?.id, status: 'CANCELLED' },
          isRead: false,
          createdAt: new Date().toISOString(),
        });

        this.notificationsGateway.emitToUser(medicId, {
          title,
          message,
          type: 'SHIFT_CANCELLED',
          data: { shiftId: shift?.id, status: 'CANCELLED' },
        });

        const extras = await getProfileExtras(this.prisma, medicId);
        const tokens = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
        if (tokens.length) {
          await this.push.sendToTokens(tokens, {
            title,
            body: message,
            data: { shiftId: String(shift?.id || ''), type: 'SHIFT_CANCELLED' },
          });
        }

        if (user?.email) {
          const html = this.emails.buildBrandedHtml({
            title,
            body: `
              <p>Hello ${user.fullName || 'Medic'},</p>
              <p>${message}</p>
              <p>Shift: <strong>${shift?.title || 'N/A'}</strong></p>
              <p>Status: <strong>CANCELLED</strong></p>
            `,
          });
          await this.emails.sendTransactional({
            to: user.email,
            subject: `Shift cancelled: ${shift?.title || 'Shift'}`,
            html,
            text: `${message} Shift: ${shift?.title || 'N/A'}.`,
            tags: { type: 'shift_cancelled' },
            metadata: { refId: String(shift?.id || '') },
          });
        }
      }),
    );
  }
}
