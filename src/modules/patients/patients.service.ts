
import { Injectable, Inject, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { TenantPrismaService } from 'src/database/tenant-prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class PatientsService {
  constructor(
    private tenantPrisma: TenantPrismaService,
    @Inject(REQUEST) private request: any,
  ) {}

  async create(data: any) {
    const tenantId = this.request.user.tenantId;
    const client = await this.tenantPrisma.getTenantClient(tenantId);
    
    // Encrypt sensitive fields (simple stub here, would use helper)
    // data.pastHistory = encrypt(data.pastHistory)

    return client.patient.create({
      data: {
        ...data,
        medicalRecords: undefined, // Handle relations appropriately
      },
    });
  }

  async findAll() {
    const tenantId = this.request.user.tenantId;
    const client = await this.tenantPrisma.getTenantClient(tenantId);
    return client.patient.findMany();
  }
}
