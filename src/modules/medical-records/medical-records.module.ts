import { Module } from '@nestjs/common';
import { MedicalRecordsController } from './medical-records.controller';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [MedicalRecordsController],
})
export class MedicalRecordsModule {}
