import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { InMemoryStore } from 'src/common/in-memory.store';
import { mergeProfileExtras } from 'src/common/profile-extras';

@Injectable()
export class ProfileExtrasBackfillService implements OnModuleInit {
  private readonly logger = new Logger(ProfileExtrasBackfillService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    const entries = InMemoryStore.listProfileExtras();
    const userIds = Object.keys(entries || {});
    if (userIds.length === 0) return;
    const existing = await this.prisma.userProfile.count();
    if (existing > 0) {
      this.logger.log(`Skipped backfill: ${existing} user_profiles already exist.`);
      return;
    }
    let backfilled = 0;
    for (const userId of userIds) {
      const payload = entries[userId];
      if (!payload || typeof payload !== 'object') continue;
      await mergeProfileExtras(this.prisma, userId, payload);
      backfilled += 1;
    }
    this.logger.log(`Backfilled profile extras for ${backfilled} users.`);
  }
}
