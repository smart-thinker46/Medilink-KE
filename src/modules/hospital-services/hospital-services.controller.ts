import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/database/prisma.service';

@Controller('hospital-services')
@UseGuards(AuthGuard('jwt'))
export class HospitalServicesController {
  constructor(private prisma: PrismaService) {}

  private get db() {
    return this.prisma as any;
  }

  private normalizeText(value: any) {
    const text = String(value || '').trim();
    return text.length ? text : '';
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

  private normalizeNumber(value: any) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async resolveHospitalTenant(
    userId: string | undefined,
    role: string | undefined,
    tenantId?: string,
  ) {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated.');
    }
    const normalizedRole = String(role || '').toUpperCase();
    if (normalizedRole === 'SUPER_ADMIN') {
      const id = this.normalizeText(tenantId);
      if (!id) {
        throw new BadRequestException('tenantId is required for this action.');
      }
      const tenant = await this.prisma.tenant.findFirst({
        where: { id, type: 'HOSPITAL' },
      });
      if (!tenant) {
        throw new BadRequestException('Hospital tenant not found.');
      }
      return tenant;
    }

    if (normalizedRole !== 'HOSPITAL_ADMIN') {
      throw new ForbiddenException('Only hospital admins can manage services.');
    }

    const link = await this.prisma.tenantUser.findFirst({
      where: {
        userId,
        tenant: { type: 'HOSPITAL' },
      },
      include: { tenant: true },
    });
    if (!link?.tenant) {
      throw new ForbiddenException('Hospital tenant not found.');
    }
    return link.tenant;
  }

  @Get()
  async listServices(@Req() req: any, @Query('tenantId') tenantId?: string) {
    const role = String(req.user?.role || '').toUpperCase();
    if (role === 'SUPER_ADMIN' && !tenantId) {
      const items = await this.db.hospitalService.findMany({
        orderBy: { updatedAt: 'desc' },
      });
      return { items };
    }

    const tenant = await this.resolveHospitalTenant(req.user?.userId, role, tenantId);
    const items = await this.db.hospitalService.findMany({
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: 'desc' },
    });
    return { items, tenantId: tenant.id };
  }

  @Post()
  async createService(@Req() req: any, @Body() body: any) {
    const tenant = await this.resolveHospitalTenant(
      req.user?.userId,
      req.user?.role,
      body?.tenantId,
    );
    const name = this.normalizeText(body?.name);
    if (!name) {
      throw new BadRequestException('Service name is required.');
    }
    const doctors = this.parseList(body?.doctors);
    const equipment = this.parseList(body?.equipment);
    const costMin = this.normalizeNumber(body?.costMin ?? body?.cost_min);
    const costMax = this.normalizeNumber(body?.costMax ?? body?.cost_max);
    if (costMin === null) {
      throw new BadRequestException('Service pricing is required (minimum cost).');
    }
    if (costMax !== null && costMax < costMin) {
      throw new BadRequestException('Maximum cost cannot be less than minimum cost.');
    }
    const status = this.normalizeText(body?.status) || 'ACTIVE';
    const created = await this.db.hospitalService.create({
      data: {
        tenantId: tenant.id,
        name,
        description: this.normalizeText(body?.description) || null,
        category: this.normalizeText(body?.category) || null,
        availability: this.normalizeText(body?.availability) || null,
        costMin,
        costMax: costMax ?? undefined,
        department: this.normalizeText(body?.department) || null,
        doctors: doctors.length ? doctors : null,
        equipment: equipment.length ? equipment : null,
        status,
      },
    });
    return created;
  }

  @Put(':id')
  async updateService(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const service = await this.db.hospitalService.findUnique({
      where: { id },
    });
    if (!service) {
      throw new BadRequestException('Service not found.');
    }

    const normalizedRole = String(req.user?.role || '').toUpperCase();
    if (normalizedRole !== 'SUPER_ADMIN') {
      const tenant = await this.resolveHospitalTenant(req.user?.userId, req.user?.role);
      if (tenant.id !== service.tenantId) {
        throw new ForbiddenException('You cannot modify this service.');
      }
    }

    const name = this.normalizeText(body?.name);
    const nextCostMin =
      body?.costMin !== undefined || body?.cost_min !== undefined
        ? this.normalizeNumber(body?.costMin ?? body?.cost_min)
        : service.costMin;
    const nextCostMax =
      body?.costMax !== undefined || body?.cost_max !== undefined
        ? this.normalizeNumber(body?.costMax ?? body?.cost_max)
        : service.costMax;
    if (nextCostMin === null) {
      throw new BadRequestException('Service pricing is required (minimum cost).');
    }
    if (nextCostMax !== null && nextCostMax < nextCostMin) {
      throw new BadRequestException('Maximum cost cannot be less than minimum cost.');
    }
    const updated = await this.db.hospitalService.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(body?.description !== undefined
          ? { description: this.normalizeText(body.description) || null }
          : {}),
        ...(body?.category !== undefined
          ? { category: this.normalizeText(body.category) || null }
          : {}),
        ...(body?.availability !== undefined
          ? { availability: this.normalizeText(body.availability) || null }
          : {}),
        ...(body?.department !== undefined
          ? { department: this.normalizeText(body.department) || null }
          : {}),
        ...(body?.costMin !== undefined || body?.cost_min !== undefined
          ? { costMin: nextCostMin }
          : {}),
        ...(body?.costMax !== undefined || body?.cost_max !== undefined
          ? { costMax: nextCostMax ?? undefined }
          : {}),
        ...(body?.doctors !== undefined
          ? {
              doctors: this.parseList(body.doctors).length
                ? this.parseList(body.doctors)
                : null,
            }
          : {}),
        ...(body?.equipment !== undefined
          ? {
              equipment: this.parseList(body.equipment).length
                ? this.parseList(body.equipment)
                : null,
            }
          : {}),
        ...(body?.status !== undefined
          ? { status: this.normalizeText(body.status) || 'ACTIVE' }
          : {}),
      },
    });
    return updated;
  }

  @Delete(':id')
  async deleteService(@Req() req: any, @Param('id') id: string) {
    const service = await this.db.hospitalService.findUnique({
      where: { id },
    });
    if (!service) {
      throw new BadRequestException('Service not found.');
    }
    const normalizedRole = String(req.user?.role || '').toUpperCase();
    if (normalizedRole !== 'SUPER_ADMIN') {
      const tenant = await this.resolveHospitalTenant(req.user?.userId, req.user?.role);
      if (tenant.id !== service.tenantId) {
        throw new ForbiddenException('You cannot delete this service.');
      }
    }
    await this.db.hospitalService.delete({ where: { id } });
    return { success: true };
  }
}
