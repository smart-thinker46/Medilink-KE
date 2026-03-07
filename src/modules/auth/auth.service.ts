import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/database/prisma.service';
import { LoginUserDto, RegisterUserDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { Tenant, TenantType, User } from '@prisma/client';
import { getProfileExtras } from 'src/common/profile-extras';
import { EmailsService } from '../emails/emails.service';
import { randomInt, randomUUID } from 'crypto';
import { AuthTransientStore } from './auth-transient.store';
import {
  computePasswordExpiryDate,
  isPasswordExpired,
  normalizePasswordIntervalDays,
} from 'src/common/security/password-policy';

type LoginContext = {
  user: User;
  extras: Record<string, any>;
  tenantId: string | null | undefined;
  tenantType: TenantType | null;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private emails: EmailsService,
    private authTransientStore: AuthTransientStore,
  ) {}

  private get emailsEnabled() {
    const raw = String(this.config.get<string>('EMAILS_ENABLED') ?? 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
  }

  private get loginOtpRequired() {
    if (!this.emailsEnabled) return false;
    const raw = String(this.config.get<string>('AUTH_LOGIN_OTP_REQUIRED') ?? 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
  }

  private get otpExpiryMinutes() {
    const raw = Number(this.config.get<string>('AUTH_OTP_EXPIRY_MINUTES') || 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 10;
  }

  private get otpMaxAttempts() {
    const raw = Number(this.config.get<string>('AUTH_OTP_MAX_ATTEMPTS') || 5);
    return Number.isFinite(raw) && raw > 0 ? raw : 5;
  }

  private get loginOtpRateWindowSeconds() {
    const raw = Number(this.config.get<string>('AUTH_LOGIN_OTP_WINDOW_SECONDS') || 300);
    return Number.isFinite(raw) && raw > 0 ? raw : 300;
  }

  private get loginOtpRateMaxPerWindow() {
    const raw = Number(this.config.get<string>('AUTH_LOGIN_OTP_MAX_PER_WINDOW') || 3);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
  }

  private get passwordResetRateWindowSeconds() {
    const raw = Number(this.config.get<string>('AUTH_PASSWORD_RESET_WINDOW_SECONDS') || 900);
    return Number.isFinite(raw) && raw > 0 ? raw : 900;
  }

  private get passwordResetRateMaxPerWindow() {
    const raw = Number(this.config.get<string>('AUTH_PASSWORD_RESET_MAX_PER_WINDOW') || 5);
    return Number.isFinite(raw) && raw > 0 ? raw : 5;
  }

  private generateOtpCode(length = 6) {
    let code = '';
    for (let i = 0; i < length; i += 1) {
      code += String(randomInt(0, 10));
    }
    return code;
  }

  private maskEmail(email: string) {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return email;
    const safeLocal =
      local.length <= 2
        ? `${local[0] || '*'}*`
        : `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 1))}`;
    return `${safeLocal}@${domain}`;
  }

  private normalizeIp(value: string | null | undefined) {
    const ip = String(value || '').trim();
    if (!ip) return '';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
  }

  private async enforceRateLimit(params: {
    scope: string;
    identifier: string;
    max: number;
    windowSeconds: number;
    errorLabel: string;
  }) {
    const result = await this.authTransientStore.checkRateLimit({
      scope: params.scope,
      identifier: params.identifier,
      max: params.max,
      windowSeconds: params.windowSeconds,
    });
    if (!result.allowed) {
      throw new BadRequestException(
        `Too many ${params.errorLabel} requests. Try again in ${result.retryAfterSeconds} seconds.`,
      );
    }
  }

  private async resolveLoginContext(dto: LoginUserDto): Promise<LoginContext> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { tenants: { include: { tenant: true } } },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    const extras = await getProfileExtras(this.prisma, user.id);
    if (extras?.blocked) throw new UnauthorizedException('Account suspended');

    if (user.status !== 'active') throw new UnauthorizedException('Account suspended');
    if (isPasswordExpired(user.passwordExpiresAt)) {
      throw new UnauthorizedException('Password expired. Please reset your password.');
    }

    let tenantId: string | null | undefined = dto.tenantId;
    let tenantType: TenantType | null = null;

    if (tenantId) {
      const link = user.tenants.find((t) => t.tenantId === tenantId);
      if (!link) throw new UnauthorizedException('Access denied to this tenant');
      tenantType = link.tenant.type;
    } else if (user.tenants.length > 0) {
      const primary = user.tenants.find((t) => t.isPrimary) || user.tenants[0];
      tenantId = primary.tenantId;
      tenantType = primary.tenant.type;
    }

    return {
      user,
      extras: extras || {},
      tenantId,
      tenantType,
    };
  }

  private async buildLoginSuccess(context: LoginContext) {
    await this.prisma.user.update({
      where: { id: context.user.id },
      data: { lastLogin: new Date() },
    });

    const token = await this.signToken(
      context.user.id,
      context.user.email,
      context.user.role,
      context.tenantId || undefined,
      context.tenantType || undefined,
    );

    return {
      accessToken: token,
      user: {
        id: context.user.id,
        email: context.user.email,
        role: context.user.role,
        fullName: context.user.fullName,
        status: context.user.status,
        blocked: Boolean(context.extras?.blocked),
        passwordPolicy: {
          intervalDays: context.user.passwordUpdateIntervalDays || null,
          expiresAt: context.user.passwordExpiresAt || null,
          expired: false,
        },
      },
      tenantId: context.tenantId,
    };
  }

  private async sendLoginOtp(context: LoginContext, clientIp?: string | null) {
    await this.enforceRateLimit({
      scope: 'login-otp-email',
      identifier: context.user.email,
      max: this.loginOtpRateMaxPerWindow,
      windowSeconds: this.loginOtpRateWindowSeconds,
      errorLabel: 'OTP',
    });
    const ip = this.normalizeIp(clientIp);
    if (ip) {
      await this.enforceRateLimit({
        scope: 'login-otp-ip',
        identifier: ip,
        max: this.loginOtpRateMaxPerWindow,
        windowSeconds: this.loginOtpRateWindowSeconds,
        errorLabel: 'OTP',
      });
    }

    const otpCode = this.generateOtpCode(6);
    const otpHash = await bcrypt.hash(otpCode, 10);
    const challengeId = randomUUID();
    const expiresAt = Date.now() + this.otpExpiryMinutes * 60 * 1000;
    const locale = (context.extras?.language || 'en') as 'en' | 'sw';

    await this.authTransientStore.clearLoginOtpsByUser(context.user.id);
    await this.authTransientStore.createLoginOtp({
      purpose: 'LOGIN',
      userId: context.user.id,
      email: context.user.email,
      challengeId,
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: this.otpMaxAttempts,
      tenantId: context.tenantId || null,
      tenantType: context.tenantType || null,
      createdAt: new Date().toISOString(),
    });

    const body = `<p>${this.emails.t(locale, 'login_otp_body')}</p>
      <p><strong>${this.emails.t(locale, 'otp_code_label')}:</strong> ${otpCode}</p>
      <p>${this.emails.t(locale, 'otp_expiry_line')} ${this.otpExpiryMinutes} minute(s).</p>`;

    try {
      await this.emails.sendTransactional({
        to: context.user.email,
        subject: this.emails.t(locale, 'login_otp_title'),
        html: this.emails.buildBrandedHtml({
          title: this.emails.t(locale, 'login_otp_title'),
          body,
          locale,
        }),
        text: `${this.emails.t(locale, 'login_otp_body')} OTP: ${otpCode}. Expires in ${this.otpExpiryMinutes} minute(s).`,
        tags: { type: 'login-otp' },
      });
    } catch {
      throw new BadRequestException('Unable to send login OTP right now. Please try again.');
    }

    return {
      requiresOtp: true,
      challengeId,
      expiresInSeconds: this.otpExpiryMinutes * 60,
      destination: this.maskEmail(context.user.email),
    };
  }

  private async verifyLoginOtp(context: LoginContext, challengeId: string, otp: string) {
    const record = await this.authTransientStore.findLoginOtp(challengeId);

    if (!record || record.userId !== context.user.id || record.purpose !== 'LOGIN') {
      throw new UnauthorizedException('OTP challenge is invalid or expired. Please request a new OTP.');
    }

    if (record.expiresAt <= Date.now()) {
      await this.authTransientStore.deleteLoginOtp(record.challengeId, record.userId);
      throw new UnauthorizedException('OTP has expired. Please request a new OTP.');
    }

    if (record.attempts >= record.maxAttempts) {
      await this.authTransientStore.deleteLoginOtp(record.challengeId, record.userId);
      throw new UnauthorizedException('OTP attempts exceeded. Please request a new OTP.');
    }

    const isValidOtp = await bcrypt.compare(String(otp || '').trim(), record.otpHash);
    if (!isValidOtp) {
      await this.authTransientStore.updateLoginOtpAttempts(
        record.challengeId,
        (record.attempts || 0) + 1,
      );
      throw new UnauthorizedException('Invalid OTP code');
    }

    await this.authTransientStore.deleteLoginOtp(record.challengeId, record.userId);
    return this.buildLoginSuccess(context);
  }

  async register(dto: RegisterUserDto) {
    // Check if user exists
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const normalizedPhone = dto.phone?.trim() || undefined;
    if (normalizedPhone) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phone: normalizedPhone },
      });
      if (existingPhone) {
        throw new ConflictException('Phone number already in use');
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.password, salt);

    // Transaction to create User and potentially Tenant
    return this.prisma.$transaction(async (tx) => {
      const fullName = dto.fullName || `${dto.firstName || ''} ${dto.lastName || ''}`.trim();

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          fullName: fullName,
          role: dto.role,
          phone: normalizedPhone,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          gender: dto.gender,
          emergencyContactName: dto.emergencyContactName,
          emergencyContactPhone: dto.emergencyContactPhone,
        },
      });

      // Handle Medic Profile Creation
      if (dto.role === 'MEDIC' && dto.licenseNumber && dto.specialization) {
        await tx.medic.create({
          data: {
            userId: user.id,
            licenseNumber: dto.licenseNumber,
            specialization: dto.specialization,
            experienceYears: dto.experienceYears,
            consultationFee: dto.consultationFee,
            bio: dto.bio,
          },
        });
      }

      let tenant: Tenant | null = null;
      // If Hospital/Pharmacy Admin, create Tenant record
      if ((dto.role === 'HOSPITAL_ADMIN' || dto.role === 'PHARMACY_ADMIN') && dto.tenantName) {
        if (!dto.tenantType) throw new BadRequestException('Tenant Type required for Admin registration');

        tenant = await tx.tenant.create({
          data: {
            name: dto.tenantName,
            type: dto.tenantType,
            registrationNumber: dto.registrationNumber,
            email: dto.email,
            phone: dto.phone,
            status: 'PENDING', // Waiting verification
          },
        });

        // Link User to Tenant
        await tx.tenantUser.create({
          data: {
            userId: user.id,
            tenantId: tenant.id,
            role: dto.role,
            isPrimary: true,
          },
        });
      }

      const token = await this.signToken(user.id, user.email, user.role, tenant?.id, tenant?.type);
      const extras = await getProfileExtras(tx, user.id);
      const locale = (extras?.language || 'en') as 'en' | 'sw';
      // Never block account creation on external email provider latency/failures.
      void this.emails
        .sendTransactional({
          to: user.email,
          subject: this.emails.t(locale, 'welcome_title'),
          html: this.emails.buildBrandedHtml({
            title: this.emails.t(locale, 'welcome_title'),
            body: `<p>${this.emails.t(locale, 'welcome_body')}</p><p>${this.emails.t(locale, 'welcome_security')}</p>`,
            locale,
          }),
          text: this.emails.t(locale, 'welcome_body'),
          tags: { type: 'welcome' },
        })
        .catch(() => undefined);

      return {
        user: { id: user.id, email: user.email, role: user.role },
        tenant,
        accessToken: token,
      };
    });
  }

  async login(dto: LoginUserDto, clientIp?: string | null) {
    const context = await this.resolveLoginContext(dto);

    if (!this.loginOtpRequired) {
      return this.buildLoginSuccess(context);
    }

    const hasChallenge = Boolean(String(dto.challengeId || '').trim());
    const hasOtp = Boolean(String(dto.otp || '').trim());

    if (hasChallenge !== hasOtp) {
      throw new BadRequestException('Both challengeId and otp are required for OTP verification');
    }

    if (!hasChallenge) {
      return this.sendLoginOtp(context, clientIp);
    }

    return this.verifyLoginOtp(context, String(dto.challengeId || '').trim(), String(dto.otp || '').trim());
  }

  private async signToken(userId: string, email: string, role: string, tenantId?: string, tenantType?: string) {
    const payload = {
      sub: userId,
      email,
      role,
      tenantId: tenantId || undefined,
      tenantType: tenantType || undefined,
    };
    return this.jwt.signAsync(payload);
  }

  async requestPasswordReset(email: string, clientIp?: string | null) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new BadRequestException('Email is required');

    if (!this.emailsEnabled) {
      return {
        success: true,
        message: 'Password reset email is temporarily disabled.',
      };
    }

    await this.enforceRateLimit({
      scope: 'password-reset-email',
      identifier: normalizedEmail,
      max: this.passwordResetRateMaxPerWindow,
      windowSeconds: this.passwordResetRateWindowSeconds,
      errorLabel: 'password reset',
    });
    const ip = this.normalizeIp(clientIp);
    if (ip) {
      await this.enforceRateLimit({
        scope: 'password-reset-ip',
        identifier: ip,
        max: this.passwordResetRateMaxPerWindow,
        windowSeconds: this.passwordResetRateWindowSeconds,
        errorLabel: 'password reset',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return { success: true };
    }
    await this.authTransientStore.clearPasswordResetsByUser(user.id);
    let token = this.generateOtpCode(6);
    for (let i = 0; i < 5; i += 1) {
      if (!(await this.authTransientStore.hasPasswordResetToken(token))) break;
      token = this.generateOtpCode(6);
    }

    const expiresAt = Date.now() + 1000 * 60 * 30;
    await this.authTransientStore.createPasswordReset({
      userId: user.id,
      email: user.email,
      token,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    const appUrl = this.config.get<string>('APP_BASE_URL') || 'http://localhost:8081';
    const resetLink = `${appUrl}/reset-password?token=${token}`;
    const locale = ((await getProfileExtras(this.prisma, user.id))?.language || 'en') as 'en' | 'sw';
    await this.emails
      .sendTransactional({
        to: user.email,
        subject: this.emails.t(locale, 'password_reset_title'),
        html: this.emails.buildBrandedHtml({
          title: this.emails.t(locale, 'password_reset_title'),
          body: `<p>${this.emails.t(locale, 'password_reset_body')}</p>
            <p><strong>${this.emails.t(locale, 'otp_code_label')}:</strong> ${token}</p>
            <p>${this.emails.t(locale, 'otp_expiry_line')} 30 minute(s).</p>`,
          ctaLabel: this.emails.t(locale, 'reset_button'),
          ctaUrl: resetLink,
          locale,
        }),
        text: `Reset OTP: ${token}. Reset link: ${resetLink}`,
        tags: { type: 'password_reset' },
      })
      .catch(() => undefined);
    return { success: true };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword) throw new BadRequestException('Token and password required');
    const normalizedToken = String(token).trim();
    const record = await this.authTransientStore.findPasswordReset(normalizedToken);
    if (!record || record.expiresAt < Date.now()) {
      throw new BadRequestException('Reset token is invalid or expired');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, email: true, passwordUpdateIntervalDays: true },
    });
    if (!user) throw new BadRequestException('User account not found');

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    const changedAt = new Date();
    const intervalDays = normalizePasswordIntervalDays(user.passwordUpdateIntervalDays);
    const expiresAt = computePasswordExpiryDate(intervalDays, changedAt);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordChangedAt: changedAt,
        passwordExpiresAt: expiresAt,
      },
    });
    await this.authTransientStore.deletePasswordReset(record.token, record.userId);
    const localeChanged = ((await getProfileExtras(this.prisma, user.id))?.language || 'en') as 'en' | 'sw';
    await this.emails
      .sendTransactional({
        to: user.email,
        subject: this.emails.t(localeChanged, 'password_changed_title'),
        html: this.emails.buildBrandedHtml({
          title: this.emails.t(localeChanged, 'password_changed_title'),
          body: `<p>${this.emails.t(localeChanged, 'password_changed_body')}</p>`,
          locale: localeChanged,
        }),
        text: this.emails.t(localeChanged, 'password_changed_body'),
        tags: { type: 'password_changed' },
      })
      .catch(() => undefined);
    return { success: true };
  }
}
