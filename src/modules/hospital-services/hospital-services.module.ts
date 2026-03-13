import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/database/database.module';
import { HospitalServicesController } from './hospital-services.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [HospitalServicesController],
})
export class HospitalServicesModule {}
