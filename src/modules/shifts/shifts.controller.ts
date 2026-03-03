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
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { ensureHospitalProfileComplete, ensureMedicProfileComplete } from 'src/common/profile-validation';
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

    return this.db.shift.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId;
    await ensureHospitalProfileComplete(this.prisma, userId);

    const extras = await getProfileExtras(this.prisma, userId);
    const payload: any = {
      title: body.title || body.task,
      description: body.description,
      specifications: body.specifications,
      specialization: body.specialization || body.category || null,
      requiredMedics: Number(body.requiredMedics || body.medicsRequired || 0),
      hours: Number(body.hours || 0),
      payType: body.payType,
      payAmount: Number(body.payAmount || 0),
      status: 'OPEN',
      createdBy: userId,
      hospitalName: extras.hospitalName || body.hospitalName,
      location: extras.locationAddress || extras.location || body.location,
      applications: [],
    };
    return this.db.shift.create({ data: payload });
  }

  @Post(':id/apply')
  async apply(@Req() req: any, @Param('id') id: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'MEDIC') {
      throw new ForbiddenException('Only medics can apply to shifts.');
    }

    const shift = await this.db.shift.findUnique({ where: { id } });
    if (!shift) return { success: false };

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

    const updated = await this.db.shift.update({
      where: { id },
      data: {
      title: body.title ?? body.task ?? shift.title,
      description: body.description ?? shift.description,
      specifications: body.specifications ?? body.requirements ?? shift.specifications,
      specialization: body.specialization ?? body.category ?? shift.specialization,
      requiredMedics: body.requiredMedics ?? body.medicsRequired ?? shift.requiredMedics,
      hours: body.hours ?? shift.hours,
      payType: body.payType ?? shift.payType,
      payAmount: body.payAmount ?? shift.payAmount,
      location: body.location ?? shift.location,
      status: body.status ?? shift.status,
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
      cancellationReason: body?.reason || 'Cancelled by hospital admin',
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
