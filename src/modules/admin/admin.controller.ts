import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Query,
  Put,
  Param,
  Body,
  UseGuards,
  Req,
  Post,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { PrismaService } from 'src/database/prisma.service';
import { UserRole } from '@prisma/client';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtrasMap, mergeProfileExtras } from 'src/common/profile-extras';
import { NotificationsGateway } from 'src/modules/notifications/notifications.gateway';
import { EmailsService } from 'src/modules/emails/emails.service';
import * as bcrypt from 'bcrypt';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), SuperAdminGuard)
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
    private emails: EmailsService,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  @Get('overview')
  async overview() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        dateOfBirth: true,
        gender: true,
      },
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    const withExtras = users.map((user) => ({
      ...user,
      extras: extrasMap.get(user.id) || {},
    }));

    const totalUsers = withExtras.length;
    const counts = withExtras.reduce(
      (acc, user) => {
        const role = user.role || 'UNKNOWN';
        acc[role] = (acc[role] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const subscriptionActive = withExtras.filter((u) => u.extras?.subscriptionActive).length;
    const subscriptionInactive = totalUsers - subscriptionActive;

    const payments = InMemoryStore.list('payments');
    const revenueTotal = payments.reduce((sum, p: any) => sum + (p.amount || 0), 0);
    const subscriptionPayments = payments.filter(
      (p: any) =>
        String(p?.type || '').toUpperCase() === 'SUBSCRIPTION' &&
        String(p?.status || '').toUpperCase() === 'PAID',
    );
    const subscriptionRevenue = subscriptionPayments.reduce(
      (sum: number, payment: any) => sum + Number(payment?.amount || 0),
      0,
    );

    const shifts = InMemoryStore.list('shifts') as any[];
    const appointments = InMemoryStore.list('appointments') as any[];
    const orders = InMemoryStore.list('orders') as any[];

    const topHospitals = this.rankByCount(shifts, 'createdBy');
    const topMedics = this.rankByCount(appointments, 'medicId');
    const topPharmacies = this.rankByCount(orders, 'pharmacyId');

    const complaints = InMemoryStore.list('complaints');

    const approvedUsers = withExtras.filter((u) => Boolean((u as any)?.extras?.verified || (u as any)?.extras?.isVerified)).length;
    const nonApprovedUsers = totalUsers - approvedUsers;
    const blockedUsers = withExtras.filter(
      (u: any) => u.status === 'suspended' || Boolean(u?.extras?.blocked),
    ).length;
    const onlineUsers = withExtras.filter((u) => this.notificationsGateway.isUserOnline(u.id)).length;
    const offlineUsers = totalUsers - onlineUsers;

    const profileCompletion = withExtras.reduce(
      (acc, user: any) => {
        const complete = this.isProfileComplete(user, user?.extras || {});
        if (complete) acc.completed += 1;
        else acc.incomplete += 1;
        return acc;
      },
      { completed: 0, incomplete: 0 },
    );

    const pricing = InMemoryStore.getSubscriptionPricing?.() || {};
    const unpaidUsers = withExtras.filter((u: any) => {
      const role = String(u.role || '');
      if (role === 'SUPER_ADMIN' || role === 'PATIENT') return false;
      return !Boolean(u?.extras?.subscriptionActive);
    });
    const unpaidUsersCount = unpaidUsers.length;
    const unpaidAmountEstimate = unpaidUsers.reduce((sum: number, user: any) => {
      const role = String(user.role || '');
      const rolePricing = pricing?.[role] || {};
      return sum + Number(rolePricing?.monthly || 0);
    }, 0);

    const shiftSummary = shifts.reduce(
      (acc, shift: any) => {
        const status = String(shift?.status || 'PENDING').toUpperCase();
        acc.total += 1;
        if (status === 'COMPLETED') acc.completed += 1;
        else if (status === 'CANCELLED' || status === 'CANCELED') acc.cancelled += 1;
        else acc.pending += 1;
        return acc;
      },
      { total: 0, completed: 0, pending: 0, cancelled: 0 },
    );

    return {
      totals: {
        totalUsers,
        patients: counts.PATIENT || 0,
        medics: counts.MEDIC || 0,
        hospitals: counts.HOSPITAL_ADMIN || 0,
        pharmacies: counts.PHARMACY_ADMIN || 0,
        subscriptionActive,
        subscriptionInactive,
      },
      revenue: {
        total: revenueTotal,
        subscriptions: subscriptionRevenue,
        currency: 'KES',
      },
      analytics: {
        approvals: {
          approved: approvedUsers,
          nonApproved: nonApprovedUsers,
        },
        onlineStatus: {
          online: onlineUsers,
          offline: offlineUsers,
        },
        profiles: profileCompletion,
        blocked: {
          blocked: blockedUsers,
          unblocked: Math.max(totalUsers - blockedUsers, 0),
        },
        subscriptions: {
          active: subscriptionActive,
          inactive: subscriptionInactive,
          revenue: subscriptionRevenue,
          unpaidUsersCount,
          unpaidAmountEstimate,
          currency: 'KES',
        },
        shifts: shiftSummary,
      },
      top: {
        hospitals: await this.mapUsers(topHospitals),
        medics: await this.mapUsers(topMedics),
        pharmacies: await this.mapUsers(topPharmacies),
      },
      complaintsCount: complaints.length,
    };
  }

  private hasValue(value: any) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  private isProfileComplete(user: any, extras: Record<string, any>) {
    const role = String(user?.role || '');
    const fullName = String(user?.fullName || '').trim();
    const firstName = String(extras?.firstName || '').trim();
    const lastName = String(extras?.lastName || '').trim();

    if (role === 'PATIENT') {
      return [
        firstName || fullName,
        lastName || fullName,
        user?.phone,
        user?.dateOfBirth,
        user?.gender,
        extras?.homeCountry,
        extras?.subCounty,
        extras?.ward,
        extras?.location,
        extras?.idFront,
        extras?.idBack,
        extras?.profilePhoto,
      ].every((value) => this.hasValue(value));
    }

    if (role === 'MEDIC') {
      return [
        firstName || fullName,
        lastName || fullName,
        user?.phone,
        user?.dateOfBirth,
        user?.gender,
        extras?.professionalType,
        extras?.specialization,
        extras?.licenseNumber,
        extras?.license,
        extras?.idFront,
        extras?.idBack,
        extras?.institution,
        extras?.qualifications,
        extras?.yearCompleted,
        extras?.experienceYears,
        extras?.cv,
      ].every((value) => this.hasValue(value));
    }

    if (role === 'HOSPITAL_ADMIN') {
      return [
        extras?.hospitalName,
        extras?.facilityType,
        extras?.registrationNumber,
        extras?.license,
        extras?.adminName,
        extras?.adminContact,
        extras?.adminEmail,
        extras?.county,
        extras?.subCounty || extras?.locationAddress,
        extras?.nearestTown,
        extras?.bedCapacity,
        extras?.specialties,
        extras?.operatingHours,
        extras?.workingDays,
      ].every((value) => this.hasValue(value));
    }

    if (role === 'PHARMACY_ADMIN') {
      const hasDeliveryFlag = typeof extras?.deliveryAvailable === 'boolean';
      return (
        [
          extras?.pharmacyName,
          extras?.pharmacyType,
          extras?.registrationNumber,
          extras?.license,
          extras?.ownerName,
          extras?.ownerPhone,
          extras?.ownerEmail,
          extras?.ownerIdFront,
          extras?.ownerIdBack,
          extras?.county || extras?.locationTown,
          extras?.townCity || extras?.nearestTown,
          extras?.operatingHours,
          extras?.offDays,
          extras?.pharmacistInChargeName,
          extras?.pharmacistInChargePhone,
          extras?.pharmacistInChargeEmail,
        ].every((value) => this.hasValue(value)) && hasDeliveryFlag
      );
    }

    return this.hasValue(fullName) && this.hasValue(user?.phone);
  }

  private parseBooleanQuery(value?: string) {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return undefined;
  }

  private async listAdminUsers(filters: {
    role?: string;
    active?: string;
    verified?: string;
    search?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    sort?: string;
    online?: string;
  }) {
    const roleFilter =
      filters?.role && Object.values(UserRole).includes(filters.role as UserRole)
        ? (filters.role as UserRole)
        : undefined;
    const statusFilter =
      filters?.status && ['active', 'suspended'].includes(filters.status) ? filters.status : undefined;
    const activeFilter = this.parseBooleanQuery(filters?.active);
    const verifiedFilter = this.parseBooleanQuery(filters?.verified);
    const onlineFilter = this.parseBooleanQuery(filters?.online);

    const createdAtFilter: any = {};
    if (filters?.startDate) {
      const start = new Date(filters.startDate);
      if (!Number.isNaN(start.getTime())) {
        createdAtFilter.gte = start;
      }
    }
    if (filters?.endDate) {
      const end = new Date(filters.endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        createdAtFilter.lte = end;
      }
    }

    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
      where: {
        ...(roleFilter ? { role: roleFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
      },
      orderBy: {
        createdAt: filters?.sort === 'oldest' ? 'asc' : 'desc',
      },
    });

    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    let list = users.map((user) => {
      const extras = extrasMap.get(user.id) || {};
      return {
        id: user.id,
        firstName: extras.firstName || user.fullName?.split(' ')[0] || '',
        lastName: extras.lastName || user.fullName?.split(' ').slice(1).join(' ') || '',
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        location: extras.location?.address || extras.locationAddress || extras.address || '',
        verified: Boolean(extras.verified || extras.isVerified),
        verifiedAt: extras.verifiedAt || null,
        blockedAt: extras.blockedAt || null,
        licenseNumber: extras.licenseNumber || extras.license || '',
        licenseFile: extras.license || extras.licenseUrl || '',
        idPhoto: extras.idPhoto || extras.idPhotoUrl || extras.adminId || extras.adminIdUrl || '',
        idFront: extras.idFront || extras.idFrontUrl || '',
        idBack: extras.idBack || extras.idBackUrl || '',
        subscriptionActive: Boolean(extras.subscriptionActive),
        isOnline: this.notificationsGateway.isUserOnline(user.id),
      };
    });

    if (activeFilter !== undefined) {
      list = list.filter((item) => item.subscriptionActive === activeFilter);
    }

    if (verifiedFilter !== undefined) {
      list = list.filter((item) => item.verified === verifiedFilter);
    }

    if (onlineFilter !== undefined) {
      list = list.filter((item) => item.isOnline === onlineFilter);
    }

    if (filters?.search) {
      const needle = filters.search.toLowerCase();
      list = list.filter(
        (item) =>
          item.firstName.toLowerCase().includes(needle) ||
          item.lastName.toLowerCase().includes(needle) ||
          item.email?.toLowerCase().includes(needle),
      );
    }

    return list;
  }

  @Get('users')
  async users(
    @Query('role') role?: string,
    @Query('active') active?: string,
    @Query('verified') verified?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('sort') sort?: string,
    @Query('online') online?: string,
  ) {
    const list = await this.listAdminUsers({
      role,
      active,
      verified,
      search,
      status,
      startDate,
      endDate,
      sort,
      online,
    });

    const pageNumber = Math.max(1, Number(page) || 1);
    const size = Math.min(200, Math.max(5, Number(pageSize) || 20));
    const total = list.length;
    const start = (pageNumber - 1) * size;
    const items = list.slice(start, start + size);

    return {
      items,
      total,
      page: pageNumber,
      pageSize: size,
    };
  }

  @Put('users/:id/block')
  async blockUser(@Param('id') id: string, @Body() body: any) {
    const blocked = body?.blocked ?? true;
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { email: true, fullName: true },
    });
    await mergeProfileExtras(this.prisma, id, {
      blocked: Boolean(blocked),
      blockedAt: blocked ? new Date().toISOString() : null,
    });
    await this.prisma.user.update({
      where: { id },
      data: { status: blocked ? 'suspended' : 'active' },
    });
    const notification = InMemoryStore.create('notifications', {
      userId: id,
      title: blocked ? 'Account Blocked' : 'Account Unblocked',
      message: blocked
        ? 'Your account has been blocked by an administrator. Please contact support.'
        : 'Your account has been unblocked. You can access the dashboard again.',
      type: 'ACCOUNT',
      relatedId: id,
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    this.notificationsGateway.emitToUser(id, {
      title: notification.title,
      message: notification.message,
    });
    if (user?.email) {
      await this.emails
        .sendAccountStatusNotification({
          to: user.email,
          blocked: Boolean(blocked),
          userName: user.fullName || 'User',
          locale: body?.locale === 'sw' ? 'sw' : 'en',
        })
        .catch(() => undefined);
    }
    InMemoryStore.logAudit({
      action: blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
      targetId: id,
      createdAt: new Date().toISOString(),
    });
    return { success: true, blocked: Boolean(blocked) };
  }

  @Post('users')
  async createUser(@Req() req: any, @Body() body: any) {
    const role = body.role && Object.values(UserRole).includes(body.role) ? body.role : 'PATIENT';
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    if (!email || !password) {
      return { success: false, message: 'Email and password are required' };
    }
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return { success: false, message: 'Email already in use' };
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashed,
        role,
        fullName: body.fullName || undefined,
        phone: body.phone || undefined,
        status: body.status || 'active',
      },
    });
    await mergeProfileExtras(this.prisma, user.id, {
      firstName: body.firstName,
      lastName: body.lastName,
      address: body.address,
      location: body.location,
      profilePhoto: body.profilePhoto,
      idFront: body.idFront,
      idBack: body.idBack,
      license: body.license,
      adminId: body.adminId,
      cv: body.cv,
      specialization: body.specialization,
      licenseNumber: body.licenseNumber,
      experienceYears: body.experienceYears,
      consultationFee: body.consultationFee,
      services: body.services,
      paymentModes: body.paymentModes,
      patientVolume: body.patientVolume,
      pharmacyName: body.pharmacyName,
      hospitalName: body.hospitalName,
      adminName: body.adminName,
      locationAddress: body.locationAddress,
    });
    InMemoryStore.logAudit({
      action: 'ADMIN_USER_CREATED',
      targetId: user.id,
      createdAt: new Date().toISOString(),
      by: req.user?.userId,
    });
    return { success: true, user };
  }

  @Put('users/:id')
  async updateUser(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const updates: any = {};
    if (body.email) updates.email = String(body.email).trim().toLowerCase();
    if (body.phone) updates.phone = body.phone;
    if (body.fullName) updates.fullName = body.fullName;
    if (body.status) updates.status = body.status;
    if (body.role && Object.values(UserRole).includes(body.role)) updates.role = body.role;
    if (body.password) updates.password = await bcrypt.hash(String(body.password), 10);

    const user = await this.prisma.user.update({
      where: { id },
      data: updates,
    });

    await mergeProfileExtras(this.prisma, id, {
      firstName: body.firstName,
      lastName: body.lastName,
      address: body.address,
      location: body.location,
      profilePhoto: body.profilePhoto,
      idFront: body.idFront,
      idBack: body.idBack,
      license: body.license,
      adminId: body.adminId,
      cv: body.cv,
      specialization: body.specialization,
      licenseNumber: body.licenseNumber,
      experienceYears: body.experienceYears,
      consultationFee: body.consultationFee,
      services: body.services,
      paymentModes: body.paymentModes,
      patientVolume: body.patientVolume,
      pharmacyName: body.pharmacyName,
      hospitalName: body.hospitalName,
      adminName: body.adminName,
      locationAddress: body.locationAddress,
    });

    InMemoryStore.logAudit({
      action: 'ADMIN_USER_UPDATED',
      targetId: id,
      createdAt: new Date().toISOString(),
      by: req.user?.userId,
    });
    return { success: true, user };
  }

  private async deleteUserCascade(targetId: string, requesterId: string) {
    if (!targetId) {
      throw new BadRequestException('User id is required.');
    }
    if (!requesterId) {
      throw new UnauthorizedException('Unauthenticated admin request.');
    }
    if (targetId === requesterId) {
      throw new BadRequestException('You cannot delete your own admin account.');
    }

    const existing = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true },
    });
    if (!existing) {
      throw new BadRequestException('User not found.');
    }

    if (existing.role === UserRole.SUPER_ADMIN) {
      const superAdminCount = await this.prisma.user.count({
        where: { role: UserRole.SUPER_ADMIN },
      });
      if (superAdminCount <= 1) {
        throw new BadRequestException('Cannot delete the last super admin account.');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.updateMany({
        where: { userId: targetId },
        data: { userId: null },
      });
      await tx.tenantUser.deleteMany({ where: { userId: targetId } });
      await tx.message.deleteMany({
        where: {
          OR: [{ senderId: targetId }, { recipientId: targetId }],
        },
      });
      await tx.medicalRecord.updateMany({
        where: { medicId: targetId },
        data: { medicId: null },
      });
      await tx.medicalRecord.deleteMany({ where: { patientId: targetId } });
      await tx.userProfile.deleteMany({ where: { userId: targetId } });

      const txAny = tx as any;
      if (txAny?.medic?.deleteMany) {
        await txAny.medic.deleteMany({ where: { userId: targetId } });
      }
      if (txAny?.systemAdmin?.deleteMany) {
        await txAny.systemAdmin.deleteMany({ where: { userId: targetId } });
      }

      await tx.user.delete({ where: { id: targetId } });
    });

    this.pruneInMemoryUserData(targetId);
    InMemoryStore.logAudit({
      action: 'ADMIN_USER_DELETED',
      targetId,
      by: requesterId,
      createdAt: new Date().toISOString(),
    });
  }

  @Delete('users/:id')
  async deleteUser(@Req() req: any, @Param('id') id: string) {
    const targetId = String(id || '').trim();
    const requesterId = String(req?.user?.userId || '').trim();
    await this.deleteUserCascade(targetId, requesterId);
    return { success: true, deletedUserId: targetId };
  }

  @Post('users/delete/bulk')
  async deleteUsersBulk(@Req() req: any, @Body() body: any) {
    const requesterId = String(req?.user?.userId || '').trim();
    if (!requesterId) {
      throw new UnauthorizedException('Unauthenticated admin request.');
    }

    const explicitIds: string[] = Array.isArray(body?.userIds)
      ? body.userIds
          .map((id: any) => String(id || '').trim())
          .filter((id: string) => id.length > 0)
      : [];
    const deleteAll = Boolean(body?.deleteAll);

    let targetIds: string[] = Array.from(new Set(explicitIds));
    if (deleteAll) {
      const filters = body?.filters || {};
      const users = await this.listAdminUsers({
        role: filters?.role,
        active: filters?.active,
        verified: filters?.verified,
        search: filters?.search,
        status: filters?.status,
        startDate: filters?.startDate,
        endDate: filters?.endDate,
        sort: filters?.sort,
        online: filters?.online,
      });
      targetIds = users
        .map((user: any) => String(user?.id || '').trim())
        .filter((id: string) => id.length > 0);
    }

    targetIds = targetIds.filter((id: string) => id !== requesterId);
    if (!targetIds.length) {
      throw new BadRequestException('No eligible users selected for deletion.');
    }

    const deletedUserIds: string[] = [];
    const failed: Array<{ userId: string; reason: string }> = [];

    for (const userId of targetIds) {
      try {
        await this.deleteUserCascade(userId, requesterId);
        deletedUserIds.push(userId);
      } catch (error: any) {
        failed.push({
          userId,
          reason: String(error?.message || 'Delete failed'),
        });
      }
    }

    InMemoryStore.logAudit({
      action: deleteAll ? 'ADMIN_USERS_BULK_DELETED_FILTERED' : 'ADMIN_USERS_BULK_DELETED_SELECTED',
      targetId: requesterId,
      createdAt: new Date().toISOString(),
      details: {
        requested: targetIds.length,
        deleted: deletedUserIds.length,
        failed: failed.length,
      },
    });

    return {
      success: failed.length === 0,
      requestedCount: targetIds.length,
      deletedCount: deletedUserIds.length,
      deletedUserIds,
      failed,
    };
  }

  @Put('users/:id/verify')
  async verifyUser(@Param('id') id: string, @Body() body: any) {
    const verified = body?.verified ?? true;
    await mergeProfileExtras(this.prisma, id, {
      verified: Boolean(verified),
      isVerified: Boolean(verified),
      verifiedAt: verified ? new Date().toISOString() : null,
    });
    InMemoryStore.logAudit({
      action: verified ? 'USER_VERIFIED' : 'USER_UNVERIFIED',
      targetId: id,
      createdAt: new Date().toISOString(),
    });
    return { success: true, verified: Boolean(verified) };
  }

  @Put('users/verify/bulk')
  async verifyUsersBulk(@Req() req: any, @Body() body: any) {
    const verified = body?.verified ?? true;
    const userIds = Array.isArray(body?.userIds)
      ? body.userIds.filter((id: any) => typeof id === 'string' && id.trim().length > 0)
      : [];

    if (!userIds.length) {
      return { success: false, message: 'userIds is required', updated: 0 };
    }

    const verifiedAt = verified ? new Date().toISOString() : null;
    await Promise.all(
      userIds.map((id) =>
        mergeProfileExtras(this.prisma, id, {
          verified: Boolean(verified),
          isVerified: Boolean(verified),
          verifiedAt,
        }),
      ),
    );

    InMemoryStore.logAudit({
      action: verified ? 'USERS_BULK_VERIFIED' : 'USERS_BULK_UNVERIFIED',
      targetId: req.user?.userId,
      createdAt: new Date().toISOString(),
      details: { count: userIds.length, userIds },
    });

    return {
      success: true,
      verified: Boolean(verified),
      updated: userIds.length,
      userIds,
    };
  }

  @Get('complaints')
  async complaints() {
    return InMemoryStore.list('complaints');
  }

  @Get('subscriptions')
  async subscriptions() {
    return InMemoryStore.list('subscriptions');
  }

  @Get('subscription-pricing')
  async subscriptionPricing() {
    return InMemoryStore.getSubscriptionPricing();
  }

  @Put('subscription-pricing')
  async updateSubscriptionPricing(@Req() req: any, @Body() body: any) {
    const updated = InMemoryStore.setSubscriptionPricing(body || {});
    InMemoryStore.logAudit({
      action: 'SUBSCRIPTION_PRICING_UPDATED',
      targetId: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Put('subscriptions/:id/status')
  async updateSubscription(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const status = body.status || 'ACTIVE';
    const updated = InMemoryStore.update('subscriptions', id, {
      status,
      pausedAt: status === 'PAUSED' ? new Date().toISOString() : null,
      canceledAt: status === 'CANCELED' ? new Date().toISOString() : null,
    });
    InMemoryStore.logAudit({
      action: 'SUBSCRIPTION_STATUS_UPDATED',
      targetId: id,
      createdAt: new Date().toISOString(),
    });
    if (updated?.userId) {
      await mergeProfileExtras(this.prisma, updated.userId, {
        subscriptionActive: status === 'ACTIVE',
      });
      const user = await this.prisma.user.findUnique({
        where: { id: updated.userId },
        select: { email: true },
      });
      if (user?.email) {
        if (String(status).toUpperCase() === 'ACTIVE') {
          await this.emails
            .sendSubscriptionSuccess({
              to: user.email,
              plan: updated?.plan || 'monthly',
              amount: Number(updated?.amount || 0),
              currency: updated?.currency || 'KES',
              locale: body?.locale === 'sw' ? 'sw' : 'en',
            })
            .catch(() => undefined);
        } else {
          await this.emails
            .sendSubscriptionReminder({
              to: user.email,
              daysLeft: Number(body?.daysLeft || 0),
              locale: body?.locale === 'sw' ? 'sw' : 'en',
            })
            .catch(() => undefined);
        }
      }
    }
    return updated;
  }

  @Get('shifts')
  async shifts() {
    return InMemoryStore.list('shifts');
  }

  @Get('hiring')
  async hiring() {
    return {
      approvals: InMemoryStore.list('medicApprovals'),
      hires: InMemoryStore.list('medicHires'),
    };
  }

  @Get('operations')
  async operations() {
    const shifts = InMemoryStore.list('shifts') as any[];
    const hires = InMemoryStore.list('medicHires') as any[];
    const appointments = InMemoryStore.list('appointments') as any[];

    const userIds = Array.from(
      new Set([
        ...shifts.map((s) => s.createdBy).filter(Boolean),
        ...hires.map((h) => h.medicId).filter(Boolean),
        ...hires.map((h) => h.hospitalAdminId).filter(Boolean),
        ...appointments.map((a) => a.patientId).filter(Boolean),
        ...appointments.map((a) => a.medicId).filter(Boolean),
        ...shifts.flatMap((s) =>
          (s.applications || []).map((a: any) => a?.medicId).filter(Boolean),
        ),
      ]),
    );

    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, email: true, role: true },
        })
      : [];
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    const userMap = new Map(users.map((u) => [u.id, u]));
    const nameOf = (id?: string) => {
      if (!id) return 'Unknown';
      const user = userMap.get(id);
      const extras = extrasMap.get(id) || {};
      return (
        extras.hospitalName ||
        extras.pharmacyName ||
        user?.fullName ||
        user?.email ||
        id
      );
    };

    const shiftStatuses = shifts.reduce(
      (acc, shift) => {
        const status = String(shift.status || 'PENDING').toUpperCase();
        if (status === 'COMPLETED') acc.completed += 1;
        else if (status === 'CANCELLED') acc.cancelled += 1;
        else if (status === 'HIRED') acc.hired += 1;
        else acc.pending += 1;
        return acc;
      },
      { pending: 0, completed: 0, cancelled: 0, hired: 0 },
    );

    const hospitalsWhoCreatedShifts = this.rankByCount(shifts, 'createdBy').map((item) => ({
      id: item.id,
      name: nameOf(item.id),
      shifts: item.count,
    }));

    const shiftApplications = shifts.flatMap((shift) =>
      (shift.applications || []).map((application: any) => ({
        shiftId: shift.id,
        shiftTitle: shift.title || shift.task || 'Shift',
        medicId: application?.medicId || null,
        medicName: nameOf(application?.medicId),
        appliedAt: application?.appliedAt || null,
        hospitalId: shift.createdBy,
        hospitalName: nameOf(shift.createdBy),
      })),
    );

    const hiresDetailed = hires.map((hire) => ({
      id: hire.id,
      medicId: hire.medicId,
      medicName: nameOf(hire.medicId),
      hospitalAdminId: hire.hospitalAdminId,
      hospitalName: nameOf(hire.hospitalAdminId),
      status: hire.status || 'HIRED',
      createdAt: hire.createdAt,
    }));

    const patientMedicCounts = appointments.reduce((acc, appointment) => {
      const patientId = appointment?.patientId;
      const medicId = appointment?.medicId;
      const status = String(appointment?.status || '').toUpperCase();
      if (!patientId || !medicId || status === 'CANCELLED') return acc;
      const key = `${patientId}:${medicId}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const medicHiredByPatients = (Object.entries(patientMedicCounts) as [string, number][])
      .map(([key, count]) => {
        const [patientId, medicId] = key.split(':');
        return {
          patientId,
          patientName: nameOf(patientId),
          medicId,
          medicName: nameOf(medicId),
          interactions: Number(count || 0),
        };
      })
      .sort((a, b) => b.interactions - a.interactions);

    const mostHiredMedic = medicHiredByPatients.reduce(
      (acc, row) => {
        const current = acc[row.medicId] || 0;
        acc[row.medicId] = current + row.interactions;
        return acc;
      },
      {} as Record<string, number>,
    );

    const topMedic = Object.entries(mostHiredMedic)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)
      .map(([id, total]) => ({
        medicId: id,
        medicName: nameOf(id),
        totalPatientHires: total,
      }))[0] || null;

    const byDayHospital = shifts.reduce((acc, shift) => {
      const day = String(shift.createdAt || '').slice(0, 10);
      const hospitalId = shift.createdBy || '';
      if (!day || !hospitalId) return acc;
      const key = `${day}:${hospitalId}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topHospitalDaily = (Object.entries(byDayHospital) as [string, number][])
      .map(([key, count]) => {
        const [date, hospitalId] = key.split(':');
        return {
          date,
          hospitalId,
          hospitalName: nameOf(hospitalId),
          shifts: Number(count || 0),
        };
      })
      .sort((a, b) => b.shifts - a.shifts)
      .slice(0, 14);

    return {
      totals: {
        shifts: shifts.length,
        shiftApplications: shiftApplications.length,
        hires: hiresDetailed.length,
      },
      shiftStatuses,
      hospitalsWhoCreatedShifts,
      shiftApplications,
      hiresDetailed,
      medicHiredByPatients,
      topMedic,
      topHospitalDaily,
    };
  }

  @Get('reports/activities')
  async activityReport() {
    const operations = await this.operations();
    const auditLogs = InMemoryStore.list('auditLogs') as any[];
    const notifications = InMemoryStore.list('notifications') as any[];
    const messages = await this.prisma.message.findMany({
      select: {
        id: true,
        senderId: true,
        recipientId: true,
        createdAt: true,
        readAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalAuditEvents: auditLogs.length,
        totalNotifications: notifications.length,
        totalMessages: messages.length,
        totalShifts: operations?.totals?.shifts || 0,
        totalShiftApplications: operations?.totals?.shiftApplications || 0,
        totalHires: operations?.totals?.hires || 0,
      },
      operations,
      auditLogs: auditLogs.slice().reverse(),
      recentMessages: messages,
    };
  }

  @Put('users/:id/restrictions')
  async restrictions(@Param('id') id: string, @Body() body: any) {
    await mergeProfileExtras(this.prisma, id, {
      restrictions: body?.restrictions || [],
    });
    InMemoryStore.logAudit({
      action: 'USER_RESTRICTIONS_UPDATED',
      targetId: id,
      createdAt: new Date().toISOString(),
    });
    return { success: true };
  }

  @Put('notifications')
  async notify(@Req() req: any, @Body() body: any) {
    const audience = body.audience || 'ALL';
    const users = await this.resolveAudienceUsers(audience, body.userId);
    const userIds = users.map((user) => user.id);

    const record = InMemoryStore.create('adminNotifications', {
      title: body.title,
      message: body.message,
      audience,
      targetUserId: body.userId || null,
      createdBy: req.user?.userId,
      createdAt: new Date().toISOString(),
      sendEmail: Boolean(body.sendEmail),
    });

    users.forEach((user) => {
      InMemoryStore.create('notifications', {
        userId: user.id,
        title: body.title,
        message: body.message,
        type: body.type || 'INFO',
        relatedId: record.id,
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    });
    this.notificationsGateway.emitToUsers(userIds, {
      title: body.title,
      message: body.message,
    });

    let emailReport: any = {
      requested: Boolean(body.sendEmail),
      sent: 0,
      failed: 0,
      targets: users.filter((u) => !!u.email).length,
      errors: [] as string[],
    };

    if (body.sendEmail) {
      const emailTargets = users.filter((user) => !!user.email).map((user) => user.email);
      if (emailTargets.length > 0) {
        try {
          const html =
            body.emailHtml ||
            this.emails.buildBrandedHtml({
              title: body.emailSubject || body.title || 'MediLink Update',
              body: `<p>${String(body.message || '').replace(/\n/g, '<br/>')}</p>`,
              locale: (body.locale || 'en') === 'sw' ? 'sw' : 'en',
            });
          await this.emails.sendTransactional({
            to: emailTargets,
            subject: body.emailSubject || body.title || 'MediLink Notification',
            html,
            text: body.emailText || body.message || '',
            tags: { type: 'admin-notification' },
            metadata: { refId: record.id },
          });
          emailReport.sent = emailTargets.length;
        } catch (error) {
          emailReport.failed = emailTargets.length;
          emailReport.errors.push(error?.message || 'Failed to send emails.');
        }
      } else {
        emailReport.errors.push('No recipients with email address found.');
      }
    }

    InMemoryStore.logAudit({
      action: 'ADMIN_NOTIFICATION_SENT',
      targetId: record.id,
      createdAt: new Date().toISOString(),
    });
    return {
      ...record,
      recipients: userIds.length,
      email: emailReport,
    };
  }

  @Put('messages')
  async messages(@Req() req: any, @Body() body: any) {
    const audience = body.audience || 'ALL';
    const users = await this.resolveAudienceUsers(audience, body.userId);
    const userIds = users.map((user) => user.id);

    const record = InMemoryStore.create('messages', {
      channel: body.channel,
      message: body.message,
      audience,
      title: body.title || 'Admin Message',
      targetUserId: body.userId || null,
      createdBy: req.user?.userId,
      createdAt: new Date().toISOString(),
    });

    users.forEach((user) => {
      InMemoryStore.create('notifications', {
        userId: user.id,
        title: body.title || 'Admin Message',
        message: body.message,
        type: body.type || 'INFO',
        relatedId: record.id,
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    });
    this.notificationsGateway.emitToUsers(userIds, {
      title: body.title || 'Admin Message',
      message: body.message,
      type: body.type || 'INFO',
    });

    InMemoryStore.logAudit({
      action: 'ADMIN_MESSAGE_SENT',
      targetId: record.id,
      createdAt: new Date().toISOString(),
    });
    return {
      ...record,
      recipients: userIds.length,
    };
  }

  @Get('notifications')
  async notifications() {
    return InMemoryStore.list('adminNotifications');
  }

  @Put('complaints/:id/resolve')
  async resolveComplaint(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const updated = InMemoryStore.update('complaints', id, {
      status: body.status || 'RESOLVED',
      resolution: body.resolution || '',
      resolvedBy: req.user?.userId,
      resolvedAt: new Date().toISOString(),
    });
    InMemoryStore.logAudit({
      action: 'COMPLAINT_RESOLVED',
      targetId: id,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('audit-logs')
  async auditLogs() {
    return InMemoryStore.list('auditLogs').slice().reverse();
  }

  private getAdminModel(modelName: string) {
    return (this.db as any)?.[modelName];
  }

  private isMissingTableError(error: any) {
    return String(error?.code || '') === 'P2021';
  }

  private async dbFindMany(
    modelName: string,
    args: any,
    fallbackCollection?: any,
  ) {
    const model = this.getAdminModel(modelName);
    if (!model?.findMany) {
      return fallbackCollection ? InMemoryStore.list(fallbackCollection as any) : [];
    }
    try {
      return await model.findMany(args);
    } catch (error) {
      if (this.isMissingTableError(error)) {
        return fallbackCollection ? InMemoryStore.list(fallbackCollection as any) : [];
      }
      throw error;
    }
  }

  private async dbFindFirst(
    modelName: string,
    args: any,
    fallbackCollection?: any,
  ) {
    const model = this.getAdminModel(modelName);
    if (!model?.findFirst) {
      return fallbackCollection ? (InMemoryStore.list(fallbackCollection) as any[])[0] || null : null;
    }
    try {
      return await model.findFirst(args);
    } catch (error) {
      if (this.isMissingTableError(error)) {
        return fallbackCollection ? (InMemoryStore.list(fallbackCollection) as any[])[0] || null : null;
      }
      throw error;
    }
  }

  private async dbCreate(
    modelName: string,
    payload: Record<string, any>,
    fallbackCollection?: any,
  ) {
    const model = this.getAdminModel(modelName);
    if (!model?.create) {
      return fallbackCollection ? InMemoryStore.create(fallbackCollection, payload as any) : payload;
    }
    try {
      return await model.create({ data: payload });
    } catch (error) {
      if (this.isMissingTableError(error)) {
        return fallbackCollection ? InMemoryStore.create(fallbackCollection, payload as any) : payload;
      }
      throw error;
    }
  }

  private async dbUpdate(
    modelName: string,
    id: string,
    payload: Record<string, any>,
    fallbackCollection?: any,
  ) {
    const model = this.getAdminModel(modelName);
    if (!model?.update) {
      return fallbackCollection ? InMemoryStore.update(fallbackCollection, id, payload as any) : null;
    }
    try {
      return await model.update({ where: { id }, data: payload });
    } catch (error) {
      const missingRecord = String(error?.code || '') === 'P2025';
      if (this.isMissingTableError(error) || missingRecord) {
        return fallbackCollection ? InMemoryStore.update(fallbackCollection, id, payload as any) : null;
      }
      throw error;
    }
  }

  private pruneInMemoryUserData(userId: string) {
    const collectionRules: Array<{ collection: string; keys: string[] }> = [
      { collection: 'appointments', keys: ['userId', 'patientId', 'medicId'] },
      { collection: 'orders', keys: ['userId', 'patientId', 'buyerId', 'createdBy'] },
      { collection: 'payments', keys: ['userId', 'recipientId', 'payerId', 'patientId'] },
      { collection: 'notifications', keys: ['userId'] },
      { collection: 'videoCalls', keys: ['callerId', 'calleeId', 'userId'] },
      { collection: 'medicApprovals', keys: ['userId', 'medicId', 'approvedBy'] },
      { collection: 'medicHires', keys: ['medicId', 'patientId', 'hospitalAdminId', 'hiredBy'] },
      { collection: 'complaints', keys: ['userId', 'patientId', 'assignedTo'] },
      { collection: 'subscriptions', keys: ['userId'] },
      { collection: 'adminNotifications', keys: ['userId', 'createdBy'] },
      { collection: 'messages', keys: ['userId', 'senderId', 'recipientId', 'createdBy'] },
      { collection: 'emails', keys: ['userId', 'toUserId', 'createdBy'] },
      { collection: 'supportChatRequests', keys: ['requesterId', 'adminId', 'userId'] },
      { collection: 'aiVoiceSessions', keys: ['userId'] },
      { collection: 'aiVoiceEvents', keys: ['userId'] },
      { collection: 'aiToolAudits', keys: ['userId'] },
      { collection: 'purchaseOrders', keys: ['createdBy', 'approvedBy'] },
      { collection: 'fraudCases', keys: ['userId', 'createdBy', 'updatedBy'] },
      { collection: 'supportTickets', keys: ['userId', 'createdBy', 'assignedTo', 'resolvedBy'] },
      { collection: 'policyAcceptances', keys: ['userId'] },
      { collection: 'emergencyIncidents', keys: ['patientId', 'createdBy', 'updatedBy', 'assignedTo'] },
      { collection: 'complianceRequests', keys: ['userId', 'requestedBy', 'updatedBy'] },
      { collection: 'paymentDisputes', keys: ['userId', 'createdBy', 'updatedBy'] },
      { collection: 'refunds', keys: ['userId', 'createdBy'] },
      { collection: 'withdrawals', keys: ['ownerId', 'requestedBy'] },
    ];

    collectionRules.forEach(({ collection, keys }) => {
      const rows = InMemoryStore.list(collection as any) as any[];
      if (!Array.isArray(rows) || rows.length === 0) return;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index] || {};
        const shouldRemove = keys.some((key) => String(row?.[key] || '').trim() === userId);
        if (shouldRemove) {
          rows.splice(index, 1);
        }
      }
    });
  }

  private async ensureSingleton(collection: string, defaults: Record<string, any>) {
    const modelMap: Record<string, string> = {
      rolePermissions: 'rolePermission',
      featureFlags: 'featureFlag',
    };
    const modelName = modelMap[collection] || '';
    if (!modelName) {
      const existing = (InMemoryStore.list(collection as any) as any[])[0];
      if (existing) return existing;
      return InMemoryStore.create(collection as any, {
        ...defaults,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
    }

    const existing = await this.dbFindFirst(
      modelName,
      { orderBy: { createdAt: 'asc' } },
      collection as any,
    );
    if (existing) return existing;
    return this.dbCreate(
      modelName,
      {
        ...defaults,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      collection as any,
    );
  }

  private defaultRolePermissions() {
    return {
      SUPER_ADMIN: ['*'],
      ADMIN_SUPPORT: [
        'TICKETS_VIEW',
        'TICKETS_MANAGE',
        'CHAT_RESPOND',
        'NOTIFY_USERS',
        'CONTROL_CENTER_VIEW',
      ],
      ADMIN_FINANCE: [
        'PAYMENTS_VIEW',
        'REFUNDS_APPROVE',
        'DISPUTES_MANAGE',
        'SUBSCRIPTIONS_VIEW',
        'REVENUE_VIEW',
        'CONTROL_CENTER_VIEW',
      ],
      ADMIN_COMPLIANCE: [
        'KYC_REVIEW',
        'POLICY_MANAGE',
        'DATA_EXPORT',
        'PRIVACY_REQUESTS',
        'ROLE_MATRIX_VIEW',
        'CONTROL_CENTER_VIEW',
      ],
      ADMIN_OPERATIONS: [
        'SHIFT_MONITOR',
        'EMERGENCY_DISPATCH',
        'FEATURE_FLAGS_MANAGE',
        'PLATFORM_HEALTH_VIEW',
        'FRAUD_MANAGE',
        'CONTROL_CENTER_VIEW',
      ],
    };
  }

  private defaultFeatureFlags() {
    return {
      aiAssistant: true,
      videoCalls: true,
      pharmacyMarketplace: true,
      emergencyDispatch: true,
      voiceAi: true,
      premiumEnforcement: true,
      adminControlCenter: true,
    };
  }

  private normalizeStatus(value: any, fallback = 'OPEN') {
    const text = String(value || fallback).trim().toUpperCase();
    return text || fallback;
  }

  private normalizePermissions(input: unknown) {
    if (!Array.isArray(input)) return [];
    return input
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean);
  }

  private normalizeRoleMatrix(raw: unknown) {
    const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return Object.entries(source).reduce(
      (acc, [role, permissions]) => {
        acc[String(role).trim().toUpperCase()] = this.normalizePermissions(permissions);
        return acc;
      },
      {} as Record<string, string[]>,
    );
  }

  private async assertPermission(req: any, permission: string) {
    const role = String(req?.user?.role || '').trim().toUpperCase();
    const userId = String(req?.user?.userId || '').trim();
    if (!role || !userId) {
      throw new UnauthorizedException('Unauthenticated admin request.');
    }
    if (role === 'SUPER_ADMIN') return;

    const permissionKey = String(permission || '').trim().toUpperCase();
    const singleton = (await this.ensureSingleton('rolePermissions', {
      matrix: this.defaultRolePermissions(),
      version: 1,
    })) as any;
    const matrix = this.normalizeRoleMatrix(singleton?.matrix);
    const allowed = matrix[role] || [];
    const prefix = permissionKey.includes('_')
      ? `${permissionKey.split('_')[0]}_*`
      : `${permissionKey}*`;
    if (
      allowed.includes('*') ||
      allowed.includes('ALL') ||
      allowed.includes(permissionKey) ||
      allowed.includes(prefix)
    ) {
      return;
    }
    throw new ForbiddenException(`Missing permission: ${permissionKey}`);
  }

  private async buildRevenueIntel() {
    const payments = InMemoryStore.list('payments') as any[];
    const subscriptions = InMemoryStore.list('subscriptions') as any[];
    const pricing = InMemoryStore.getSubscriptionPricing?.() || {};
    const users = await this.prisma.user.findMany({
      select: { id: true, role: true, createdAt: true },
    });
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));

    const paidPayments = payments.filter(
      (payment) => this.normalizeStatus(payment?.status, '') === 'PAID',
    );
    const failedPayments = payments.filter(
      (payment) => this.normalizeStatus(payment?.status, '') === 'FAILED',
    );
    const subscriptionRevenue = paidPayments
      .filter((payment) => this.normalizeStatus(payment?.type, '') === 'SUBSCRIPTION')
      .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0);
    const paidUsers = new Set(
      paidPayments
        .map((payment) => String(payment?.userId || payment?.payerId || payment?.patientId || '').trim())
        .filter(Boolean),
    );
    const arpu = paidUsers.size > 0 ? subscriptionRevenue / paidUsers.size : 0;

    const subscriptionStatuses = subscriptions.reduce(
      (acc, subscription) => {
        const status = this.normalizeStatus(subscription?.status, 'ACTIVE');
        if (status === 'ACTIVE') acc.active += 1;
        else if (status === 'CANCELED' || status === 'CANCELLED') acc.cancelled += 1;
        else acc.other += 1;
        return acc;
      },
      { active: 0, cancelled: 0, other: 0 },
    );

    const subscriptionUsers = users.filter((user) => {
      const role = String(user.role || '');
      return role !== 'SUPER_ADMIN' && role !== 'PATIENT';
    });
    const outstandingBalances = subscriptionUsers.reduce((sum, user: any) => {
      const extras = extrasMap.get(user.id) || {};
      if (extras?.subscriptionActive) return sum;
      const rolePrice = pricing?.[String(user.role || '')];
      return sum + Number(rolePrice?.monthly || 0);
    }, 0);

    const mrr = subscriptionUsers.reduce((sum, user: any) => {
      const extras = extrasMap.get(user.id) || {};
      if (!extras?.subscriptionActive) return sum;
      const rolePrice = pricing?.[String(user.role || '')];
      return sum + Number(rolePrice?.monthly || 0);
    }, 0);

    const cohortsMap = users.reduce((acc, user) => {
      const month = new Date(user.createdAt).toISOString().slice(0, 7);
      if (!acc[month]) acc[month] = { month, users: 0, paid: 0 };
      acc[month].users += 1;
      const extras = extrasMap.get(user.id) || {};
      if (extras?.subscriptionActive) acc[month].paid += 1;
      return acc;
    }, {} as Record<string, { month: string; users: number; paid: number }>);
    const cohorts = Object.values(cohortsMap)
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12)
      .map((cohort) => ({
        ...cohort,
        conversionRate: cohort.users > 0 ? Number(((cohort.paid / cohort.users) * 100).toFixed(1)) : 0,
      }));

    const churnRate =
      subscriptionStatuses.active + subscriptionStatuses.cancelled > 0
        ? Number(
            (
              (subscriptionStatuses.cancelled /
                (subscriptionStatuses.active + subscriptionStatuses.cancelled)) *
              100
            ).toFixed(2),
          )
        : 0;

    return {
      mrr: Number(mrr.toFixed(2)),
      churnRate,
      failedPayments: failedPayments.length,
      outstandingBalances: Number(outstandingBalances.toFixed(2)),
      arpu: Number(arpu.toFixed(2)),
      subscriptionRevenue: Number(subscriptionRevenue.toFixed(2)),
      activeSubscriptions: subscriptionStatuses.active,
      cancelledSubscriptions: subscriptionStatuses.cancelled,
      cohorts,
      currency: 'KES',
    };
  }

  @Get('role-permissions')
  async getRolePermissions(@Req() req: any) {
    await this.assertPermission(req, 'ROLE_MATRIX_VIEW');
    return await this.ensureSingleton('rolePermissions', {
      matrix: this.defaultRolePermissions(),
      version: 1,
    });
  }

  @Put('role-permissions')
  async updateRolePermissions(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'ROLE_MATRIX_MANAGE');
    const singleton = await this.ensureSingleton('rolePermissions', {
      matrix: this.defaultRolePermissions(),
      version: 1,
    }) as any;
    const matrix =
      body?.matrix && typeof body.matrix === 'object' ? body.matrix : this.defaultRolePermissions();
    const updated = await this.dbUpdate('rolePermission', singleton.id, {
      matrix,
      version: Number(singleton.version || 1) + 1,
      updatedAt: new Date(),
      updatedBy: req.user?.userId || null,
    } as any, 'rolePermissions');
    InMemoryStore.logAudit({
      action: 'ADMIN_ROLE_PERMISSION_MATRIX_UPDATED',
      targetId: singleton.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('kyc-queue')
  async getKycQueue(@Req() req: any) {
    await this.assertPermission(req, 'KYC_REVIEW');
    const users = await this.prisma.user.findMany({
      where: {
        role: { in: [UserRole.MEDIC, UserRole.PHARMACY_ADMIN, UserRole.HOSPITAL_ADMIN] },
      },
      select: {
        id: true,
        role: true,
        fullName: true,
        email: true,
        phone: true,
        status: true,
        createdAt: true,
      },
    });
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    const reviews = await this.dbFindMany(
      'kycReview',
      { orderBy: { createdAt: 'desc' } },
      'kycReviews',
    );
    const latestReviewByUser = new Map<string, any>();
    reviews.forEach((review) => {
      const userId = String(review?.userId || '');
      if (!userId) return;
      const current = latestReviewByUser.get(userId);
      if (!current || new Date(review?.createdAt || 0).getTime() > new Date(current?.createdAt || 0).getTime()) {
        latestReviewByUser.set(userId, review);
      }
    });

    const queue = users.map((user) => {
      const extras = extrasMap.get(user.id) || {};
      const hasLicense = Boolean(extras?.license || extras?.licenseNumber);
      const hasId =
        Boolean(extras?.idFront || extras?.ownerIdFront || extras?.adminIdFront) &&
        Boolean(extras?.idBack || extras?.ownerIdBack || extras?.adminIdBack);
      const verified = Boolean(extras?.verified || extras?.isVerified);
      const kycStatus = String(extras?.kycStatus || (verified ? 'APPROVED' : hasLicense && hasId ? 'PENDING_REVIEW' : 'MISSING_DOCUMENTS'));
      const latestReview = latestReviewByUser.get(user.id) || null;
      return {
        userId: user.id,
        role: user.role,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        accountStatus: user.status,
        createdAt: user.createdAt,
        kycStatus,
        documents: {
          hasLicense,
          hasId,
          licenseNumber: extras?.licenseNumber || null,
          licenseFile: extras?.license || null,
          idFront: extras?.idFront || extras?.ownerIdFront || null,
          idBack: extras?.idBack || extras?.ownerIdBack || null,
        },
        latestReview,
      };
    });

    return {
      totals: {
        total: queue.length,
        approved: queue.filter((row) => this.normalizeStatus(row.kycStatus) === 'APPROVED').length,
        pending: queue.filter((row) => this.normalizeStatus(row.kycStatus).includes('PENDING')).length,
        rejected: queue.filter((row) => this.normalizeStatus(row.kycStatus) === 'REJECTED').length,
        missingDocuments: queue.filter((row) => this.normalizeStatus(row.kycStatus) === 'MISSING_DOCUMENTS').length,
      },
      queue,
    };
  }

  @Put('kyc-queue/:userId')
  async reviewKycQueue(@Req() req: any, @Param('userId') userId: string, @Body() body: any) {
    await this.assertPermission(req, 'KYC_REVIEW');
    const status = this.normalizeStatus(body?.status, 'PENDING_REVIEW');
    const notes = String(body?.notes || '').trim();
    const verified = status === 'APPROVED';
    await mergeProfileExtras(this.prisma, userId, {
      kycStatus: status,
      verified,
      isVerified: verified,
      verifiedAt: verified ? new Date().toISOString() : null,
      kycNotes: notes || null,
      kycReviewedAt: new Date().toISOString(),
      kycReviewedBy: req.user?.userId || null,
    });
    const review = await this.dbCreate('kycReview', {
      userId,
      status,
      notes,
      reviewedAt: new Date(),
      reviewedBy: req.user?.userId || null,
      createdAt: new Date(),
    } as any, 'kycReviews');
    InMemoryStore.logAudit({
      action: 'ADMIN_KYC_REVIEW_UPDATED',
      targetId: userId,
      by: req.user?.userId,
      details: { status },
      createdAt: new Date().toISOString(),
    });
    InMemoryStore.create('notifications', {
      userId,
      title: 'KYC Review Updated',
      message: `Your KYC status is now ${status}.`,
      type: status === 'APPROVED' ? 'SUCCESS' : status === 'REJECTED' ? 'ERROR' : 'INFO',
      relatedId: review.id,
      isRead: false,
      createdAt: new Date().toISOString(),
    } as any);
    return { success: true, review };
  }

  @Get('revenue-intelligence')
  async getRevenueIntelligence(@Req() req: any) {
    await this.assertPermission(req, 'REVENUE_VIEW');
    return this.buildRevenueIntel();
  }

  @Get('fraud-center')
  async getFraudCenter(@Req() req: any) {
    await this.assertPermission(req, 'FRAUD_MANAGE');
    const cases = await this.dbFindMany(
      'fraudCase',
      { orderBy: { createdAt: 'desc' } },
      'fraudCases',
    );
    const payments = InMemoryStore.list('payments') as any[];
    const failedByUser = payments.reduce((acc, payment: any) => {
      if (this.normalizeStatus(payment?.status, '') !== 'FAILED') return acc;
      const userId = String(payment?.userId || payment?.payerId || payment?.patientId || '').trim();
      if (!userId) return acc;
      acc[userId] = (acc[userId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const suggestedAlerts = Object.entries(failedByUser)
      .filter(([, count]) => Number(count || 0) >= 3)
      .map(([userId, countRaw]) => {
        const count = Number(countRaw || 0);
        return {
          userId,
          severity: count >= 6 ? 'HIGH' : 'MEDIUM',
          type: 'FAILED_PAYMENTS_SPIKE',
          count,
        };
      });

    return {
      totals: {
        totalCases: cases.length,
        openCases: cases.filter((item) => this.normalizeStatus(item?.status) === 'OPEN').length,
        resolvedCases: cases.filter((item) => this.normalizeStatus(item?.status) === 'RESOLVED').length,
        suggestedAlerts: suggestedAlerts.length,
      },
      cases: cases.slice().sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))),
      suggestedAlerts,
    };
  }

  @Post('fraud-cases')
  async createFraudCase(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'FRAUD_MANAGE');
    const created = await this.dbCreate('fraudCase', {
      userId: body?.userId || null,
      type: String(body?.type || 'SUSPICIOUS_ACTIVITY'),
      severity: String(body?.severity || 'MEDIUM').toUpperCase(),
      status: 'OPEN',
      details: body?.details || {},
      notes: body?.notes || '',
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'fraudCases');
    InMemoryStore.logAudit({
      action: 'ADMIN_FRAUD_CASE_CREATED',
      targetId: created.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return created;
  }

  @Put('fraud-cases/:id')
  async updateFraudCase(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'FRAUD_MANAGE');
    const updated = await this.dbUpdate('fraudCase', id, {
      ...body,
      status: body?.status ? this.normalizeStatus(body?.status) : undefined,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'fraudCases');
    InMemoryStore.logAudit({
      action: 'ADMIN_FRAUD_CASE_UPDATED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('support-center')
  async getSupportCenter(@Req() req: any) {
    await this.assertPermission(req, 'TICKETS_VIEW');
    const supportRequests = InMemoryStore.list('supportChatRequests') as any[];
    const supportTickets = await this.dbFindMany(
      'supportTicket',
      { orderBy: { createdAt: 'desc' } },
      'supportTickets',
    );
    const complaints = InMemoryStore.list('complaints') as any[];
    const openTickets = supportTickets.filter((ticket) => this.normalizeStatus(ticket?.status) === 'OPEN');
    const now = Date.now();
    const slaBreaches = openTickets.filter((ticket) => {
      const createdAt = new Date(ticket?.createdAt || 0).getTime();
      if (!createdAt) return false;
      return now - createdAt > 24 * 60 * 60 * 1000;
    });

    return {
      totals: {
        supportRequests: supportRequests.length,
        openTickets: openTickets.length,
        complaintsPending: complaints.filter((item) => this.normalizeStatus(item?.status, 'OPEN') !== 'RESOLVED').length,
        slaBreaches: slaBreaches.length,
      },
      supportRequests: supportRequests.slice().reverse(),
      supportTickets: supportTickets.slice().reverse(),
      complaints: complaints.slice().reverse(),
      slaBreaches,
    };
  }

  @Post('support-tickets')
  async createSupportTicket(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'TICKETS_MANAGE');
    const ticket = await this.dbCreate('supportTicket', {
      userId: body?.userId || null,
      subject: body?.subject || 'Support Request',
      description: body?.description || '',
      priority: String(body?.priority || 'MEDIUM').toUpperCase(),
      status: 'OPEN',
      assignedTo: body?.assignedTo || null,
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'supportTickets');
    InMemoryStore.logAudit({
      action: 'ADMIN_SUPPORT_TICKET_CREATED',
      targetId: ticket.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return ticket;
  }

  @Put('support-tickets/:id')
  async updateSupportTicket(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'TICKETS_MANAGE');
    const updated = await this.dbUpdate('supportTicket', id, {
      ...body,
      status: body?.status ? this.normalizeStatus(body?.status) : undefined,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'supportTickets');
    InMemoryStore.logAudit({
      action: 'ADMIN_SUPPORT_TICKET_UPDATED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('platform-health')
  async getPlatformHealth(@Req() req: any) {
    await this.assertPermission(req, 'PLATFORM_HEALTH_VIEW');
    const payments = InMemoryStore.list('payments') as any[];
    const emails = InMemoryStore.list('emails') as any[];
    const videoCalls = InMemoryStore.list('videoCalls') as any[];
    const failedPayments = payments.filter((payment) => this.normalizeStatus(payment?.status, '') === 'FAILED').length;
    const totalPayments = payments.length;
    const paymentSuccessRate =
      totalPayments > 0 ? Number((((totalPayments - failedPayments) / totalPayments) * 100).toFixed(2)) : 100;
    const failedEmails = emails.filter((email) => this.normalizeStatus(email?.status, '') === 'FAILED').length;
    const emailSuccessRate =
      emails.length > 0 ? Number((((emails.length - failedEmails) / emails.length) * 100).toFixed(2)) : 100;
    const activeCalls = videoCalls.filter((call) => this.normalizeStatus(call?.status, '') === 'ACTIVE').length;

    const snapshot = await this.dbCreate('platformHealthSnapshot', {
      api: { status: 'UP', uptimePct: 99.9 },
      database: { status: 'UP' },
      payments: { status: paymentSuccessRate < 85 ? 'DEGRADED' : 'UP', successRate: paymentSuccessRate },
      emails: { status: emailSuccessRate < 85 ? 'DEGRADED' : 'UP', successRate: emailSuccessRate },
      videoCalls: { status: 'UP', activeCalls },
      webhooks: { status: 'UP', failures24h: 0 },
      createdAt: new Date(),
    } as any, 'platformHealthSnapshots');

    return snapshot;
  }

  @Get('content-policies')
  async getContentPolicies(@Req() req: any) {
    await this.assertPermission(req, 'POLICY_MANAGE');
    const [items, acceptances] = await Promise.all([
      this.dbFindMany('contentPolicy', { orderBy: { createdAt: 'desc' } }, 'contentPolicies'),
      this.dbFindMany('policyAcceptance', { orderBy: { acceptedAt: 'desc' } }, 'policyAcceptances'),
    ]);
    const publishedPolicies = items.filter((item) => this.normalizeStatus(item?.status, 'DRAFT') === 'PUBLISHED');
    const acceptanceRate =
      publishedPolicies.length > 0
        ? Number(
            (
              (acceptances.length /
                Math.max(
                  1,
                  publishedPolicies.length *
                    (await this.prisma.user.count({
                      where: { role: { not: UserRole.SUPER_ADMIN } },
                    })),
                )) *
              100
            ).toFixed(2),
          )
        : 0;
    return {
      items: items.slice().reverse(),
      metrics: {
        totalPolicies: items.length,
        published: publishedPolicies.length,
        acceptances: acceptances.length,
        acceptanceRate,
      },
    };
  }

  @Post('content-policies')
  async createContentPolicy(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'POLICY_MANAGE');
    const item = await this.dbCreate('contentPolicy', {
      type: String(body?.type || 'POLICY').toUpperCase(),
      title: String(body?.title || 'Untitled Policy'),
      body: String(body?.body || ''),
      version: String(body?.version || `v${new Date().toISOString().slice(0, 10)}`),
      status: 'DRAFT',
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'contentPolicies');
    InMemoryStore.logAudit({
      action: 'ADMIN_CONTENT_POLICY_CREATED',
      targetId: item.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return item;
  }

  @Put('content-policies/:id/publish')
  async publishContentPolicy(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'POLICY_MANAGE');
    const updated = await this.dbUpdate('contentPolicy', id, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      updatedAt: new Date(),
      publishedBy: req.user?.userId || null,
    } as any, 'contentPolicies');
    if (body?.broadcast && updated?.title) {
      const users = await this.prisma.user.findMany({
        where: { role: { not: UserRole.SUPER_ADMIN } },
        select: { id: true },
      });
      users.forEach((user) => {
        InMemoryStore.create('notifications', {
          userId: user.id,
          title: `Policy Update: ${updated.title}`,
          message: 'A new policy/version has been published. Please review it in settings.',
          type: 'INFO',
          relatedId: id,
          isRead: false,
          createdAt: new Date().toISOString(),
        } as any);
      });
    }
    InMemoryStore.logAudit({
      action: 'ADMIN_CONTENT_POLICY_PUBLISHED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('content-policies/:id/acceptances')
  async getContentPolicyAcceptances(@Req() req: any, @Param('id') id: string) {
    await this.assertPermission(req, 'POLICY_MANAGE');
    const allRows = await this.dbFindMany(
      'policyAcceptance',
      { where: { policyId: id }, orderBy: { acceptedAt: 'desc' } },
      'policyAcceptances',
    );
    const rows = (allRows as any[]).filter(
      (row) => String(row?.policyId || '') === String(id),
    );
    return {
      policyId: id,
      total: rows.length,
      accepted: rows.filter((row) => Boolean(row?.accepted)).length,
      declined: rows.filter((row) => !Boolean(row?.accepted)).length,
      rows: rows.slice().reverse(),
    };
  }

  @Post('content-policies/:id/acceptances')
  async createContentPolicyAcceptance(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'POLICY_MANAGE');
    const row = await this.dbCreate('policyAcceptance', {
      policyId: id,
      userId: body?.userId || req.user?.userId || null,
      accepted: Boolean(body?.accepted ?? true),
      acceptedAt: new Date(),
      metadata: body?.metadata || {},
      createdAt: new Date(),
    } as any, 'policyAcceptances');
    InMemoryStore.logAudit({
      action: 'ADMIN_POLICY_ACCEPTANCE_RECORDED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return row;
  }

  @Get('emergency-ops')
  async getEmergencyOps(@Req() req: any) {
    await this.assertPermission(req, 'EMERGENCY_DISPATCH');
    const incidents = await this.dbFindMany(
      'emergencyIncident',
      { orderBy: { createdAt: 'desc' } },
      'emergencyIncidents',
    );
    const active = incidents.filter((incident) => this.normalizeStatus(incident?.status) === 'OPEN');
    const resolved = incidents.filter((incident) => this.normalizeStatus(incident?.status) === 'RESOLVED');
    return {
      totals: {
        total: incidents.length,
        active: active.length,
        resolved: resolved.length,
      },
      incidents: incidents.slice().reverse(),
    };
  }

  @Post('emergency-ops')
  async createEmergencyIncident(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'EMERGENCY_DISPATCH');
    const locationNeedle = String(body?.location || '').trim().toLowerCase();
    const respondersRaw = await this.prisma.user.findMany({
      where: {
        role: { in: [UserRole.MEDIC, UserRole.HOSPITAL_ADMIN] },
      },
      select: { id: true, fullName: true, role: true, email: true, phone: true },
    });
    const respondersExtras = await getProfileExtrasMap(
      this.prisma,
      respondersRaw.map((user) => user.id),
    );
    const responders = respondersRaw
      .filter((user) => {
        if (!locationNeedle) return true;
        const extras = respondersExtras.get(user.id) || {};
        const text = `${extras?.location || ''} ${extras?.locationAddress || ''} ${extras?.county || ''} ${extras?.subCounty || ''}`
          .toLowerCase()
          .trim();
        return text.includes(locationNeedle);
      })
      .slice(0, 12)
      .map((user) => ({
        id: user.id,
        name: user.fullName || user.email || user.phone || user.id,
        role: user.role,
      }));

    const incident = await this.dbCreate('emergencyIncident', {
      title: body?.title || 'Emergency Incident',
      patientId: body?.patientId || null,
      location: body?.location || null,
      severity: String(body?.severity || 'HIGH').toUpperCase(),
      status: 'OPEN',
      assignedTo: body?.assignedTo || null,
      responders,
      notes: body?.notes || '',
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'emergencyIncidents');
    responders.forEach((responder) => {
      InMemoryStore.create('notifications', {
        userId: responder.id,
        title: 'Emergency Dispatch',
        message: `${incident.title} near ${incident.location || 'your area'}.`,
        type: 'WARNING',
        relatedId: incident.id,
        isRead: false,
        createdAt: new Date().toISOString(),
      } as any);
    });
    InMemoryStore.logAudit({
      action: 'ADMIN_EMERGENCY_INCIDENT_CREATED',
      targetId: incident.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return incident;
  }

  @Put('emergency-ops/:id')
  async updateEmergencyIncident(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'EMERGENCY_DISPATCH');
    const updated = await this.dbUpdate('emergencyIncident', id, {
      ...body,
      status: body?.status ? this.normalizeStatus(body?.status) : undefined,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'emergencyIncidents');
    InMemoryStore.logAudit({
      action: 'ADMIN_EMERGENCY_INCIDENT_UPDATED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('compliance-requests')
  async getComplianceRequests(@Req() req: any) {
    await this.assertPermission(req, 'PRIVACY_REQUESTS');
    const requests = await this.dbFindMany(
      'complianceRequest',
      { orderBy: { createdAt: 'desc' } },
      'complianceRequests',
    );
    return {
      totals: {
        total: requests.length,
        open: requests.filter((request) => this.normalizeStatus(request?.status, 'OPEN') === 'OPEN').length,
        completed: requests.filter((request) => this.normalizeStatus(request?.status, '') === 'COMPLETED').length,
      },
      requests: requests.slice().reverse(),
    };
  }

  @Post('compliance-requests')
  async createComplianceRequest(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'PRIVACY_REQUESTS');
    const request = await this.dbCreate('complianceRequest', {
      userId: body?.userId || null,
      type: String(body?.type || 'DATA_EXPORT').toUpperCase(),
      status: 'OPEN',
      reason: body?.reason || '',
      requestedBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'complianceRequests');
    InMemoryStore.logAudit({
      action: 'ADMIN_COMPLIANCE_REQUEST_CREATED',
      targetId: request.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return request;
  }

  @Put('compliance-requests/:id')
  async updateComplianceRequest(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'PRIVACY_REQUESTS');
    const updated = await this.dbUpdate('complianceRequest', id, {
      ...body,
      status: body?.status ? this.normalizeStatus(body?.status) : undefined,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'complianceRequests');
    InMemoryStore.logAudit({
      action: 'ADMIN_COMPLIANCE_REQUEST_UPDATED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Post('compliance-requests/export')
  async exportComplianceSnapshot(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'DATA_EXPORT');
    const scope = String(body?.scope || 'overview').toLowerCase();
    const [usersCount, subscriptionsCount] = await Promise.all([
      this.prisma.user.count(),
      Promise.resolve((InMemoryStore.list('subscriptions') as any[]).length),
    ]);
    const snapshot = {
      scope,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user?.userId || null,
      totals: {
        users: usersCount,
        subscriptions: subscriptionsCount,
        payments: (InMemoryStore.list('payments') as any[]).length,
        auditEvents: (InMemoryStore.list('auditLogs') as any[]).length,
      },
    };
    const request = await this.dbCreate('complianceRequest', {
      userId: null,
      type: 'DATA_EXPORT',
      status: 'COMPLETED',
      reason: `Generated ${scope} compliance snapshot`,
      requestedBy: req.user?.userId || null,
      completedAt: new Date(),
      payload: snapshot,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'complianceRequests');
    InMemoryStore.logAudit({
      action: 'ADMIN_COMPLIANCE_EXPORT_GENERATED',
      targetId: request.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return { request, snapshot };
  }

  @Get('feature-flags')
  async getFeatureFlags(@Req() req: any) {
    await this.assertPermission(req, 'FEATURE_FLAGS_MANAGE');
    return await this.ensureSingleton('featureFlags', {
      flags: this.defaultFeatureFlags(),
      version: 1,
    });
  }

  @Put('feature-flags')
  async updateFeatureFlags(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'FEATURE_FLAGS_MANAGE');
    const singleton = await this.ensureSingleton('featureFlags', {
      flags: this.defaultFeatureFlags(),
      version: 1,
    }) as any;
    const flags = {
      ...this.defaultFeatureFlags(),
      ...(singleton?.flags || {}),
      ...(body?.flags || {}),
    };
    const updated = await this.dbUpdate('featureFlag', singleton.id, {
      flags,
      version: Number(singleton.version || 1) + 1,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'featureFlags');
    InMemoryStore.logAudit({
      action: 'ADMIN_FEATURE_FLAGS_UPDATED',
      targetId: singleton.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  @Get('disputes')
  async getDisputes(@Req() req: any) {
    await this.assertPermission(req, 'DISPUTES_MANAGE');
    const [disputes, refunds] = await Promise.all([
      this.dbFindMany('paymentDispute', { orderBy: { createdAt: 'desc' } }, 'paymentDisputes'),
      this.dbFindMany('refund', { orderBy: { createdAt: 'desc' } }, 'refunds'),
    ]);
    return {
      totals: {
        disputes: disputes.length,
        openDisputes: disputes.filter((dispute) => this.normalizeStatus(dispute?.status, 'OPEN') === 'OPEN').length,
        refunds: refunds.length,
        pendingRefunds: refunds.filter((refund) => this.normalizeStatus(refund?.status, 'PENDING') === 'PENDING').length,
      },
      disputes: disputes.slice().reverse(),
      refunds: refunds.slice().reverse(),
    };
  }

  @Post('disputes')
  async createDispute(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'DISPUTES_MANAGE');
    const dispute = await this.dbCreate('paymentDispute', {
      paymentId: body?.paymentId || null,
      orderId: body?.orderId || null,
      userId: body?.userId || null,
      reason: body?.reason || '',
      amount: Number(body?.amount || 0),
      status: 'OPEN',
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'paymentDisputes');
    InMemoryStore.logAudit({
      action: 'ADMIN_DISPUTE_CREATED',
      targetId: dispute.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return dispute;
  }

  @Put('disputes/:id')
  async updateDispute(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    await this.assertPermission(req, 'DISPUTES_MANAGE');
    const status = body?.status ? this.normalizeStatus(body?.status) : undefined;
    const updated = await this.dbUpdate('paymentDispute', id, {
      ...body,
      status,
      updatedBy: req.user?.userId || null,
      updatedAt: new Date(),
    } as any, 'paymentDisputes');
    if (status === 'REFUND_APPROVED') {
      await this.dbCreate('refund', {
        disputeId: id,
        paymentId: updated?.paymentId || null,
        userId: updated?.userId || null,
        amount: Number(updated?.amount || 0),
        status: 'PENDING',
        createdBy: req.user?.userId || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any, 'refunds');
    }
    InMemoryStore.logAudit({
      action: 'ADMIN_DISPUTE_UPDATED',
      targetId: id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
      details: { status },
    });
    return updated;
  }

  @Post('refunds')
  async createRefund(@Req() req: any, @Body() body: any) {
    await this.assertPermission(req, 'REFUNDS_APPROVE');
    const refund = await this.dbCreate('refund', {
      disputeId: body?.disputeId || null,
      paymentId: body?.paymentId || null,
      userId: body?.userId || null,
      amount: Number(body?.amount || 0),
      reason: body?.reason || '',
      status: this.normalizeStatus(body?.status, 'PENDING'),
      createdBy: req.user?.userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any, 'refunds');
    InMemoryStore.logAudit({
      action: 'ADMIN_REFUND_CREATED',
      targetId: refund.id,
      by: req.user?.userId,
      createdAt: new Date().toISOString(),
    });
    return refund;
  }

  @Get('control-center')
  async controlCenter(@Req() req: any) {
    await this.assertPermission(req, 'CONTROL_CENTER_VIEW');
    const [
      rolePermissions,
      kyc,
      revenue,
      fraud,
      support,
      platformHealth,
      contentPolicies,
      emergencyOps,
      complianceRequests,
      featureFlags,
      disputes,
    ] = await Promise.all([
      this.getRolePermissions(req),
      this.getKycQueue(req),
      this.getRevenueIntelligence(req),
      this.getFraudCenter(req),
      this.getSupportCenter(req),
      this.getPlatformHealth(req),
      this.getContentPolicies(req),
      this.getEmergencyOps(req),
      this.getComplianceRequests(req),
      this.getFeatureFlags(req),
      this.getDisputes(req),
    ]);

    const auditLogs = await this.auditLogs();
    const topActions = (auditLogs as any[])
      .reduce((acc, row: any) => {
        const action = String(row?.action || 'UNKNOWN');
        acc[action] = (acc[action] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    const topAuditActions = Object.entries(topActions)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    return {
      generatedAt: new Date().toISOString(),
      auditTrail: {
        totalEvents: (auditLogs as any[]).length,
        recent: (auditLogs as any[]).slice(0, 15),
        topActions: topAuditActions,
      },
      rolePermissions,
      kyc,
      revenue,
      fraud,
      support,
      platformHealth,
      contentPolicies,
      emergencyOps,
      complianceRequests,
      featureFlags,
      disputes,
    };
  }

  private rankByCount(records: any[], key: string): { id: string; count: number }[] {
    const counts = records.reduce((acc, item) => {
      const id = item?.[key];
      if (!id) return acc;
      acc[id] = (acc[id] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return (Object.entries(counts) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => ({ id, count: Number(count) }));
  }

  private async mapUsers(items: { id: string; count: number }[]) {
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, email: true, role: true },
    });
    return items.map((entry) => {
      const user = users.find((u) => u.id === entry.id);
      return {
        id: entry.id,
        name: user?.fullName || 'Unknown',
        email: user?.email,
        role: user?.role,
        score: entry.count,
      };
    });
  }

  private async resolveAudienceUsers(audience: string, userId?: string) {
    if (audience === 'USER') {
      if (!userId) return [];
      const single = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, email: true },
      });
      return single ? [single] : [];
    }

    const users = await this.prisma.user.findMany({
      select: { id: true, role: true, email: true },
    });
    if (audience === 'ALL') {
      return users;
    }
    return users.filter((user) => user.role === audience);
  }

  @Get('diagnostics/shifts')
  async shiftDiagnostics(@Req() req: any, @Query('limit') limit?: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only super admin can access shift diagnostics.');
    }

    const sampleLimitRaw = Number(limit || 20);
    const sampleLimit = Number.isFinite(sampleLimitRaw)
      ? Math.min(Math.max(sampleLimitRaw, 1), 100)
      : 20;

    const [auditRows, dbShiftRows] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { resource: 'SHIFT', action: 'SHIFT_RECORD' },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.shift.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const shiftIdsInDb = new Set(
      dbShiftRows.map((row: any) => String(row?.id || '').trim()).filter(Boolean),
    );

    const normalizedAudit = auditRows.map((row) => {
      const details = (row.details as any) || {};
      const id = String(row.id || '').trim();
      const title = String(details?.title || details?.task || '').trim();
      const createdBy = String(details?.createdBy || row.userId || '').trim();
      return {
        id,
        title,
        createdBy,
        createdAt: details?.createdAt || row.createdAt?.toISOString(),
        status: String(details?.status || 'OPEN').toUpperCase(),
      };
    });

    const invalidAuditRows = normalizedAudit
      .filter((item) => !item.id || !item.title || !item.createdBy)
      .slice(0, sampleLimit);

    const missingInShiftsTable = normalizedAudit
      .filter((item) => item.id && !shiftIdsInDb.has(item.id))
      .slice(0, sampleLimit);

    const migratedFromAudit = normalizedAudit.filter((item) => shiftIdsInDb.has(item.id)).length;

    return {
      totals: {
        auditShiftRecords: normalizedAudit.length,
        shiftsTableRecords: dbShiftRows.length,
        migratedFromAudit,
        missingInShiftsTable: normalizedAudit.length - migratedFromAudit,
        invalidAuditRows: invalidAuditRows.length,
      },
      samples: {
        missingInShiftsTable,
        invalidAuditRows,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  @Post('diagnostics/shifts/backfill')
  async backfillShiftsNow(@Req() req: any) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only super admin can run shift backfill.');
    }

    const toDate = (value: any, fallback: Date | null = null) => {
      if (!value) return fallback;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? fallback : parsed;
    };
    const toInt = (value: any, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    };
    const toDecimalString = (value: any, fallback = '0') => {
      if (value === null || value === undefined || value === '') return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? String(parsed) : fallback;
    };

    const rows = await this.prisma.auditLog.findMany({
      where: { resource: 'SHIFT', action: 'SHIFT_RECORD' },
      orderBy: { createdAt: 'asc' },
    });

    const data = rows
      .map((row) => {
        const details = (row.details as any) || {};
        const title = String(details.title || details.task || '').trim();
        const createdBy = String(details.createdBy || row.userId || '').trim();
        if (!title || !createdBy) return null;

        const createdAt = toDate(details.createdAt, row.createdAt) || row.createdAt;
        const updatedAt = toDate(details.updatedAt, createdAt) || createdAt;

        return {
          id: String(row.id),
          title,
          description: details.description ? String(details.description) : null,
          specifications: details.specifications ? String(details.specifications) : null,
          specialization: details.specialization
            ? String(details.specialization)
            : details.category
              ? String(details.category)
              : null,
          requiredMedics: toInt(details.requiredMedics ?? details.medicsRequired, 0),
          hours: toInt(details.hours, 0),
          payType: details.payType ? String(details.payType) : null,
          payAmount: toDecimalString(details.payAmount, '0'),
          status: String(details.status || 'OPEN').toUpperCase(),
          createdBy,
          hospitalName: details.hospitalName ? String(details.hospitalName) : null,
          location: details.location ? String(details.location) : null,
          applications: Array.isArray(details.applications) ? details.applications : [],
          cancellationReason: details.cancellationReason
            ? String(details.cancellationReason)
            : null,
          cancelledAt: details.cancelledAt ? toDate(details.cancelledAt, null) : null,
          cancelledBy: details.cancelledBy ? String(details.cancelledBy) : null,
          createdAt,
          updatedAt,
        };
      })
      .filter(Boolean);

    const result = data.length
      ? await this.db.shift.createMany({
          data,
          skipDuplicates: true,
        })
      : { count: 0 };

    return {
      success: true,
      scanned: rows.length,
      inserted: result.count || 0,
      skipped: Math.max(data.length - (result.count || 0), 0),
      generatedAt: new Date().toISOString(),
    };
  }
}
