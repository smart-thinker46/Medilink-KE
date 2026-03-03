
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/database/prisma.service';

@Injectable()
export class TenantsService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('tenant-provisioning') private provisioningQueue: Queue,
  ) {}

  async verifyTenant(tenantId: string, verifiedByUserId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) throw new NotFoundException('Tenant not found');
    if (tenant.status === 'ACTIVE') return tenant;

    // Generate safe DB name
    const safeName = tenant.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const dbName = `medilink_tenant_${tenant.type.toLowerCase()}_${safeName}_${tenant.id.split('-')[0]}`;

    // Add job to queue
    await this.provisioningQueue.add('create-db', {
      tenantId: tenant.id,
      dbName,
      dbPassword: 'generated_secure_password', // In real setup, generate per tenant
    });

    // Mark as VERIFIED (but not yet ACTIVE / Provisioned)
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: 'VERIFIED',
        verifiedBy: verifiedByUserId,
      },
    });
  }

  async findAll() {
    return this.prisma.tenant.findMany();
  }
}
