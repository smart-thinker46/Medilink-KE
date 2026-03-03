import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { getProfileExtras } from './profile-extras';

type AccessResult = {
  enforce: boolean;
  active: boolean;
  createdAt: Date | null;
  trialEndsAt: Date | null;
  readOnly: boolean;
  daysRemaining: number | null;
};

@Injectable()
export class SubscriptionAccessService {
  private readonly trialDays = 30;
  private readonly enforceRoles = new Set(['MEDIC', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN']);

  constructor(private prisma: PrismaService) {}

  async getAccessState(userId: string, role?: string | null): Promise<AccessResult> {
    const normalizedRole = String(role || '').toUpperCase();
    const enforce = this.enforceRoles.has(normalizedRole);
    if (!enforce) {
      return {
        enforce: false,
        active: true,
        createdAt: null,
        trialEndsAt: null,
        readOnly: false,
        daysRemaining: null,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    const extras = await getProfileExtras(this.prisma, userId);
    const active = Boolean(extras?.subscriptionActive);
    const createdAt = user?.createdAt ? new Date(user.createdAt) : null;

    if (!createdAt) {
      return {
        enforce,
        active,
        createdAt: null,
        trialEndsAt: null,
        readOnly: !active,
        daysRemaining: 0,
      };
    }

    const trialEndsAt = new Date(createdAt);
    trialEndsAt.setDate(trialEndsAt.getDate() + this.trialDays);
    const now = Date.now();
    const elapsedMs = Math.max(0, now - createdAt.getTime());
    const elapsedDays = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.min(this.trialDays, Math.max(0, this.trialDays - elapsedDays));
    const readOnly = !active && daysRemaining <= 0;

    return {
      enforce,
      active,
      createdAt,
      trialEndsAt,
      readOnly,
      daysRemaining,
    };
  }
}
