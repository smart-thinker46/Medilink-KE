import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req?.user?.role === 'SUPER_ADMIN') {
      return true;
    }
    throw new ForbiddenException('Admin access only');
  }
}

