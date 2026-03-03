import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailsModule } from '../emails/emails.module';

@Module({
  imports: [NotificationsModule, EmailsModule],
  controllers: [ShiftsController],
})
export class ShiftsModule {}
