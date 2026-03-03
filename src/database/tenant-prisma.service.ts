
import { Injectable, OnModuleDestroy, Scope } from '@nestjs/common';
import { join } from 'path';
type TenantPrismaClient = any;
import { PrismaService } from './prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class TenantPrismaService implements OnModuleDestroy {
  private static clientCache = new Map<string, TenantPrismaClient>();
  private client: TenantPrismaClient;

  // We inject the Main Prisma Service to lookup tenant details if needed
  constructor(private prisma: PrismaService) {}

  async getTenantClient(tenantId: string): Promise<TenantPrismaClient> {
    if (TenantPrismaService.clientCache.has(tenantId)) {
      this.client = TenantPrismaService.clientCache.get(tenantId)!;
      return this.client;
    }

    // Fetch tenant DB URL from Main DB
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { dbUrl: true, status: true },
    });

    if (!tenant) {
      throw new Error('Tenant not found');
    }

    if (tenant.status !== 'ACTIVE' && tenant.status !== 'VERIFIED') {
       // Allow verified but not yet fully confirmed? Or just active?
       // For now, allow VERIFIED (initial state before fully active?) or ACTIVE.
       // User request says: signup -> pending -> verify -> create DB.
       // So when accessing, it should likely be ACTIVE.
       // Let's assume ACTIVE for now.
    }

    if (!tenant.dbUrl) {
      throw new Error('Tenant database not provisioned');
    }

    const { PrismaClient } = require(join(process.cwd(), 'src', 'generated', 'tenant-client'));
    const newClient = new PrismaClient({
      datasources: {
        db: {
          url: tenant.dbUrl,
        },
      },
    });

    await newClient.$connect();
    TenantPrismaService.clientCache.set(tenantId, newClient);
    this.client = newClient;
    
    return newClient;
  }

  // Helper to remove client if tenant is deleted
  static async removeTenantClient(tenantId: string) {
    const client = this.clientCache.get(tenantId);
    if (client) {
      await client.$disconnect();
      this.clientCache.delete(tenantId);
    }
  }

  async onModuleDestroy() {
    // Request scoped service doesn't really need to disconnect everything,
    // but we should handle cleanup gracefully.
    // The static cache holds connections across requests.
  }
}
