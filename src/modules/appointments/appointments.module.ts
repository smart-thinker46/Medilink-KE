import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { PrismaService } from 'src/database/prisma.service';
import { EmailsModule } from '../emails/emails.module';

@Module({
  controllers: [AppointmentsController],
  providers: [PrismaService],
  imports: [EmailsModule],
})
export class AppointmentsModule {}
