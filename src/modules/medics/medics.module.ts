import { Module } from '@nestjs/common';
import { MedicsController } from './medics.controller';
import { PrismaService } from 'src/database/prisma.service';

@Module({
  controllers: [MedicsController],
  providers: [PrismaService],
})
export class MedicsModule {}
