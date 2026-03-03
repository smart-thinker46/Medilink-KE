
import { Controller, Post, Param, UseGuards, Get } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; // Assume this standard wrapper exists or use AuthGuard('jwt')
import { AuthGuard } from '@nestjs/passport'; // Using standard for now
import { CurrentUser } from 'src/common/decorators/current-user.decorator';

@Controller('tenants')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class TenantsController {
  constructor(private tenantsService: TenantsService) {}

  @Post(':id/verify')
  @Roles('SUPER_ADMIN')
  async verifyTenant(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tenantsService.verifyTenant(id, user.userId);
  }

  @Get()
  @Roles('SUPER_ADMIN')
  async findAll() {
      return this.tenantsService.findAll();
  }
}
