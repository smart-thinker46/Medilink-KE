
import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { BullModule } from '@nestjs/bullmq';
import { TenantProvisioningConsumer } from './tenant-provisioning.consumer';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'tenant-provisioning',
    }),
  ],
  controllers: [TenantsController],
  providers: [TenantsService, TenantProvisioningConsumer],
  exports: [TenantsService],
})
export class TenantsModule {}
