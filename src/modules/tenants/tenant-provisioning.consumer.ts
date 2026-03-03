
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as bcrypt from 'bcrypt';

const execAsync = promisify(exec);

@Processor('tenant-provisioning')
@Injectable()
export class TenantProvisioningConsumer extends WorkerHost {
  private readonly logger = new Logger(TenantProvisioningConsumer.name);

  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { tenantId, dbName, dbPassword } = job.data;
    this.logger.log(`Starting provisioning for tenant ${tenantId} -> DB: ${dbName}`);

    // STUB: Real implementation involves:
    // 1. Create Postgres Role & DB (Raw SQL on Main DB)
    // 2. Run Prisma Migrations on New DB
    // 3. Update Tenant Status

    try {
        // Step 1: Create Database (Simulated or via Raw SQL if user permission allows)
        // Note: The app's DB user needs 'CREATEDB' permission. Assuming 'postgres' or similar high privs.
        
        // This is dangerous code in prod without strict sanitization. dbName is internal UUID usually.
        await this.prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}";`); 
        this.logger.log(`Database ${dbName} created.`);

        // Step 2: Run Migrations
        // We construct the connection string for the new DB
        // Assuming localhost for now as per docker-compose
        // In prod, use job.data.dbHost
        const dbUrl = `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@localhost:5432/${dbName}?schema=public`;

        this.logger.log(`Running migrations...`);
        // We must run migration for the TENANT schema
        const command = `DATABASE_URL="${dbUrl}" npx prisma migrate deploy --schema=./prisma/tenant.schema.prisma`;
        
        const { stdout, stderr } = await execAsync(command);
        this.logger.log(`Migration stdout: ${stdout}`);
        
        // Step 3: Update Tenant
        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
                status: 'ACTIVE',
                dbUrl: dbUrl, // Store the specific URL
                verifiedAt: new Date(),
            }
        });

        this.logger.log(`Tenant ${tenantId} provisioned successfully.`);

    } catch (error) {
        this.logger.error(`Failed to provision tenant ${tenantId}`, error.stack);
        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: { status: 'SUSPENDED' } // Or FAILED status if exists
        });
        throw error;
    }
  }
}
