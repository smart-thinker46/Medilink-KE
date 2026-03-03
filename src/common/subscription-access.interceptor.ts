import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { SubscriptionAccessService } from './subscription-access.service';

@Injectable()
export class SubscriptionAccessInterceptor implements NestInterceptor {
  constructor(private readonly access: SubscriptionAccessService) {}

  private normalizePath(path: string) {
    return String(path || '').split('?')[0];
  }

  private isAllowedWhenReadOnly(method: string, path: string) {
    const m = String(method || '').toUpperCase();
    const p = this.normalizePath(path);

    if (m === 'GET' && p === '/api/users/profile') return true;

    if (p === '/api/subscriptions' && m === 'POST') return true;
    if (p === '/api/subscriptions/my' && m === 'GET') return true;
    if (p === '/api/subscriptions/pricing' && m === 'GET') return true;

    if (p === '/api/payments' && m === 'POST') return true;
    if (p === '/api/payments/methods' && m === 'GET') return true;
    if (p === '/api/payments/rates' && m === 'GET') return true;
    if (p === '/api/payments/history' && m === 'GET') return true;

    return false;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const userId = req?.user?.userId;
    const role = req?.user?.role;

    if (!userId || !role) {
      return next.handle();
    }

    return from(this.access.getAccessState(userId, role)).pipe(
      mergeMap((state) => {
        if (!state.enforce || !state.readOnly) {
          return next.handle();
        }

        if (this.isAllowedWhenReadOnly(req.method, req.originalUrl || req.url)) {
          return next.handle();
        }

        throw new ForbiddenException(
          'Subscription trial has ended. Access is read-only until payment is completed.',
        );
      }),
    );
  }
}
