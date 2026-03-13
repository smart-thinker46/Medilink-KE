import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  controllers: [UsersController],
  providers: [PrismaService],
  imports: [NotificationsModule],
})
export class UsersModule {}
