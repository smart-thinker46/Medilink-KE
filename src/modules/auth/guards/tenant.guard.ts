
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    
    // Must have a tenantId in the token/request
    if (!user || !user.tenantId) {
      throw new ForbiddenException('Tenant context required for this resource');
    }

    return true;
  }
}
