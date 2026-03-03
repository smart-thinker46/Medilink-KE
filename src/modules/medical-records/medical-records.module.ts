import { Module } from '@nestjs/common';
import { MedicalRecordsController } from './medical-records.controller';

@Module({
  controllers: [MedicalRecordsController],
})
export class MedicalRecordsModule {}
