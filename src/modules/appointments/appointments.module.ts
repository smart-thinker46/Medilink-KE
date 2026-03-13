import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { PrismaService } from 'src/database/prisma.service';
import { EmailsModule } from '../emails/emails.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AppointmentsReminderService } from './appointments-reminder.service';

@Module({
  controllers: [AppointmentsController],
  providers: [PrismaService, AppointmentsReminderService],
  imports: [EmailsModule, NotificationsModule],
})
export class AppointmentsModule {}
