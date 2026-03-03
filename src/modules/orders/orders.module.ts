import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { PrismaService } from 'src/database/prisma.service';
import { EmailsModule } from '../emails/emails.module';

@Module({
  controllers: [OrdersController],
  providers: [PrismaService],
  imports: [EmailsModule],
})
export class OrdersModule {}
