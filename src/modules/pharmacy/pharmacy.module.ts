import { Module } from '@nestjs/common';
import { PharmacyController } from './pharmacy.controller';

@Module({
  controllers: [PharmacyController],
})
export class PharmacyModule {}
