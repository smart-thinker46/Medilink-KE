
import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport'; // Using standard for now

@Controller('patients')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class PatientsController {
  constructor(private patientsService: PatientsService) {}

  @Post()
  async create(@Body() createPatientDto: any) {
    // Validate DTO here
    return this.patientsService.create(createPatientDto);
  }

  @Get()
  async findAll() {
    return this.patientsService.findAll();
  }
}
