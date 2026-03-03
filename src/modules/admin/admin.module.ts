import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailsModule } from '../emails/emails.module';
import { SuperAdminGuard } from './guards/super-admin.guard';

@Module({
  imports: [NotificationsModule, EmailsModule],
  controllers: [AdminController],
  providers: [PrismaService, SuperAdminGuard],
})
export class AdminModule {}
