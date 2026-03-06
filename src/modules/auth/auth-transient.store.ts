import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { InMemoryStore } from 'src/common/in-memory.store';

export type LoginOtpRecord = {
  id: string;
  purpose: 'LOGIN';
  userId: string;
  email: string;
  challengeId: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  tenantId?: string | null;
  tenantType?: string | null;
  createdAt: string;
};

export type PasswordResetRecord = {
  id: string;
  userId: string;
  email: string;
  token: string;
  expiresAt: number;
  createdAt: string;
};

@Injectable()
export class AuthTransientStore implements OnModuleDestroy {
  private redis: Redis | null = null;
  private redisInitAttempted = false;
  private fallbackRateLimits = new Map<string, { count: number; expiresAt: number }>();

  constructor(private config: ConfigService) {}

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
    this.fallbackRateLimits.clear();
  }

  private loginOtpKey(challengeId: string) {
    return `auth:login-otp:${challengeId}`;
  }

  private loginOtpUserKey(userId: string) {
    return `auth:login-otp-user:${userId}`;
  }

  private passwordResetKey(token: string) {
    return `auth:password-reset:${token}`;
  }

  private passwordResetUserKey(userId: string) {
    return `auth:password-reset-user:${userId}`;
  }

  private rateLimitKey(scope: string, identifier: string) {
    return `auth:rate-limit:${scope}:${identifier}`;
  }

  private getRemainingTtlSeconds(expiresAt: number) {
    return Math.max(1, Math.ceil((Number(expiresAt) - Date.now()) / 1000));
  }

  private safeJsonParse<T>(value: string | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  private async getRedisClient() {
    if (this.redisInitAttempted) return this.redis;
    this.redisInitAttempted = true;

    const redisUrlRaw = String(this.config.get<string>('REDIS_URL') || '').trim();
    const redisUrl = (() => {
      if (!redisUrlRaw) return '';
      const redissIndex = redisUrlRaw.indexOf('rediss://');
      if (redissIndex >= 0) return redisUrlRaw.slice(redissIndex).trim();
      const redisIndex = redisUrlRaw.indexOf('redis://');
      if (redisIndex >= 0) return redisUrlRaw.slice(redisIndex).trim();
      return redisUrlRaw;
    })();

    const redisHostRaw = String(this.config.get<string>('REDIS_HOST') || '').trim();
    const redisPassword = String(this.config.get<string>('REDIS_PASSWORD') || '').trim();
    const redisUsername = String(this.config.get<string>('REDIS_USERNAME') || '').trim();
    const redisTls = String(this.config.get<string>('REDIS_TLS') || 'false') === 'true';
    const redisPort = Number(this.config.get<string>('REDIS_PORT') || 6379);

    try {
      if (redisUrl) {
        this.redis = new Redis(redisUrl);
      } else if (redisHostRaw.startsWith('redis://') || redisHostRaw.startsWith('rediss://')) {
        this.redis = new Redis(redisHostRaw);
      } else if (redisHostRaw) {
        this.redis = new Redis({
          host: redisHostRaw,
          port: Number.isFinite(redisPort) ? redisPort : 6379,
          username: redisUsername || undefined,
          password: redisPassword || undefined,
          ...(redisTls ? { tls: {} } : {}),
        });
      }

      if (!this.redis) return null;

      await this.redis.ping();
      this.redis.on('error', () => {
        // Keep API resilient: fall back to in-memory for this runtime.
      });
      return this.redis;
    } catch {
      this.redis = null;
      return null;
    }
  }

  async clearLoginOtpsByUser(userId: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const userKey = this.loginOtpUserKey(userId);
        const challengeIds = await redis.smembers(userKey);
        if (challengeIds.length) {
          const keys = challengeIds.map((id) => this.loginOtpKey(id));
          await redis.del(...keys, userKey);
        } else {
          await redis.del(userKey);
        }
        return;
      } catch {
        // fallback below
      }
    }

    InMemoryStore.list<LoginOtpRecord>('authOtps')
      .filter((item) => item.userId === userId)
      .forEach((item) => InMemoryStore.remove('authOtps', item.id));
  }

  async createLoginOtp(record: Omit<LoginOtpRecord, 'id'>) {
    const redis = await this.getRedisClient();
    const finalRecord: LoginOtpRecord = { id: record.challengeId, ...record };

    if (redis) {
      try {
        const ttl = this.getRemainingTtlSeconds(record.expiresAt);
        const otpKey = this.loginOtpKey(record.challengeId);
        const userKey = this.loginOtpUserKey(record.userId);
        await redis
          .multi()
          .set(otpKey, JSON.stringify(finalRecord), 'EX', ttl)
          .sadd(userKey, record.challengeId)
          .expire(userKey, ttl)
          .exec();
        return finalRecord;
      } catch {
        // fallback below
      }
    }

    return InMemoryStore.create<LoginOtpRecord>('authOtps', record);
  }

  async findLoginOtp(challengeId: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const otpKey = this.loginOtpKey(challengeId);
        const record = this.safeJsonParse<LoginOtpRecord>(await redis.get(otpKey));
        if (!record) return null;
        if (record.expiresAt <= Date.now()) {
          await redis.del(otpKey);
          return null;
        }
        return record;
      } catch {
        // fallback below
      }
    }

    const record = InMemoryStore.list<LoginOtpRecord>('authOtps').find(
      (item) => item.challengeId === challengeId,
    );
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  async updateLoginOtpAttempts(challengeId: string, attempts: number) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const otpKey = this.loginOtpKey(challengeId);
        const current = this.safeJsonParse<LoginOtpRecord>(await redis.get(otpKey));
        if (!current) return null;
        const updated = { ...current, attempts };
        const ttl = this.getRemainingTtlSeconds(current.expiresAt);
        await redis.set(otpKey, JSON.stringify(updated), 'EX', ttl);
        return updated;
      } catch {
        // fallback below
      }
    }

    const current = InMemoryStore.list<LoginOtpRecord>('authOtps').find(
      (item) => item.challengeId === challengeId,
    );
    if (!current) return null;
    return InMemoryStore.update<LoginOtpRecord>('authOtps', current.id, { attempts });
  }

  async deleteLoginOtp(challengeId: string, userId?: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const otpKey = this.loginOtpKey(challengeId);
        if (userId) {
          const userKey = this.loginOtpUserKey(userId);
          await redis.multi().del(otpKey).srem(userKey, challengeId).exec();
        } else {
          await redis.del(otpKey);
        }
        return;
      } catch {
        // fallback below
      }
    }

    const current = InMemoryStore.list<LoginOtpRecord>('authOtps').find(
      (item) => item.challengeId === challengeId,
    );
    if (current) InMemoryStore.remove('authOtps', current.id);
  }

  async clearPasswordResetsByUser(userId: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const userKey = this.passwordResetUserKey(userId);
        const tokens = await redis.smembers(userKey);
        if (tokens.length) {
          const keys = tokens.map((token) => this.passwordResetKey(token));
          await redis.del(...keys, userKey);
        } else {
          await redis.del(userKey);
        }
        return;
      } catch {
        // fallback below
      }
    }

    InMemoryStore.list<PasswordResetRecord>('passwordResets')
      .filter((item) => item.userId === userId)
      .forEach((item) => InMemoryStore.remove('passwordResets', item.id));
  }

  async hasPasswordResetToken(token: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const exists = await redis.exists(this.passwordResetKey(token));
        return exists > 0;
      } catch {
        // fallback below
      }
    }
    return InMemoryStore.list<PasswordResetRecord>('passwordResets').some((item) => item.token === token);
  }

  async createPasswordReset(record: Omit<PasswordResetRecord, 'id'>) {
    const redis = await this.getRedisClient();
    const finalRecord: PasswordResetRecord = { id: record.token, ...record };

    if (redis) {
      try {
        const ttl = this.getRemainingTtlSeconds(record.expiresAt);
        const resetKey = this.passwordResetKey(record.token);
        const userKey = this.passwordResetUserKey(record.userId);
        await redis
          .multi()
          .set(resetKey, JSON.stringify(finalRecord), 'EX', ttl)
          .sadd(userKey, record.token)
          .expire(userKey, ttl)
          .exec();
        return finalRecord;
      } catch {
        // fallback below
      }
    }

    return InMemoryStore.create<PasswordResetRecord>('passwordResets', record);
  }

  async findPasswordReset(token: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const resetKey = this.passwordResetKey(token);
        const record = this.safeJsonParse<PasswordResetRecord>(await redis.get(resetKey));
        if (!record) return null;
        if (record.expiresAt <= Date.now()) {
          await redis.del(resetKey);
          return null;
        }
        return record;
      } catch {
        // fallback below
      }
    }

    const record = InMemoryStore.list<PasswordResetRecord>('passwordResets').find(
      (item) => item.token === token,
    );
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  async deletePasswordReset(token: string, userId?: string) {
    const redis = await this.getRedisClient();
    if (redis) {
      try {
        const resetKey = this.passwordResetKey(token);
        if (userId) {
          const userKey = this.passwordResetUserKey(userId);
          await redis.multi().del(resetKey).srem(userKey, token).exec();
        } else {
          await redis.del(resetKey);
        }
        return;
      } catch {
        // fallback below
      }
    }

    const current = InMemoryStore.list<PasswordResetRecord>('passwordResets').find(
      (item) => item.token === token,
    );
    if (current) InMemoryStore.remove('passwordResets', current.id);
  }

  async checkRateLimit(params: {
    scope: string;
    identifier: string;
    max: number;
    windowSeconds: number;
  }) {
    const scope = String(params.scope || '').trim();
    const identifier = String(params.identifier || '').trim().toLowerCase();
    const max = Number(params.max || 0);
    const windowSeconds = Number(params.windowSeconds || 0);
    if (!scope || !identifier || max <= 0 || windowSeconds <= 0) {
      return { allowed: true, remaining: max, retryAfterSeconds: 0 };
    }

    const redis = await this.getRedisClient();
    const key = this.rateLimitKey(scope, identifier);

    if (redis) {
      try {
        const current = await redis.incr(key);
        if (current === 1) {
          await redis.expire(key, windowSeconds);
        }
        const ttl = await redis.ttl(key);
        const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
        const allowed = current <= max;
        const remaining = Math.max(0, max - current);
        return { allowed, remaining, retryAfterSeconds };
      } catch {
        // fallback below
      }
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const existing = this.fallbackRateLimits.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.fallbackRateLimits.set(key, { count: 1, expiresAt: now + windowMs });
      return { allowed: true, remaining: Math.max(0, max - 1), retryAfterSeconds: windowSeconds };
    }

    const nextCount = existing.count + 1;
    existing.count = nextCount;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.expiresAt - now) / 1000));
    const allowed = nextCount <= max;
    const remaining = Math.max(0, max - nextCount);
    return { allowed, remaining, retryAfterSeconds };
  }
}
