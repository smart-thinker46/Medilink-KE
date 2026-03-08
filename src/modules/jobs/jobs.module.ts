import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailsModule } from '../emails/emails.module';

@Module({
  imports: [NotificationsModule, EmailsModule],
  controllers: [JobsController],
})
export class JobsModule {}
