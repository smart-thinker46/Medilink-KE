import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/database/prisma.service';
import { LoginUserDto, RegisterUserDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { Tenant, TenantType } from '@prisma/client';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtras } from 'src/common/profile-extras';
import { EmailsService } from '../emails/emails.service';
import { randomUUID } from 'crypto';
import {
  computePasswordExpiryDate,
  isPasswordExpired,
  normalizePasswordIntervalDays,
} from 'src/common/security/password-policy';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private emails: EmailsService,
  ) {}

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
           }
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

  async login(dto: LoginUserDto) {
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

    // Determine Tenant Context
    // If tenantId provided, verify user belongs to it
    // If not, pick primary or default, or none (global login)
    
    let tenantId: string | null | undefined = dto.tenantId;
    let tenantType: TenantType | null = null;

    if (tenantId) {
      const link = user.tenants.find(t => t.tenantId === tenantId);
      if (!link) throw new UnauthorizedException('Access denied to this tenant');
      tenantType = link.tenant.type;
    } else if (user.tenants.length > 0) {
      // Default to primary or first
      const primary = user.tenants.find(t => t.isPrimary) || user.tenants[0];
      tenantId = primary.tenantId;
      tenantType = primary.tenant.type;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    const token = await this.signToken(user.id, user.email, user.role, tenantId || undefined, tenantType || undefined);

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName,
        status: user.status,
        blocked: Boolean(extras?.blocked),
        passwordPolicy: {
          intervalDays: user.passwordUpdateIntervalDays || null,
          expiresAt: user.passwordExpiresAt || null,
          expired: false,
        },
      },
      tenantId, 
    };
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

  async requestPasswordReset(email: string) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new BadRequestException('Email is required');
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return { success: true };
    }
    const token = randomUUID();
    const expiresAt = Date.now() + 1000 * 60 * 30;
    InMemoryStore.create('passwordResets', {
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
          body: `<p>${this.emails.t(locale, 'password_reset_body')}</p>`,
          ctaLabel: this.emails.t(locale, 'reset_button'),
          ctaUrl: resetLink,
          locale,
        }),
        text: `Reset your password: ${resetLink}`,
        tags: { type: 'password_reset' },
      })
      .catch(() => undefined);
    return { success: true };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword) throw new BadRequestException('Token and password required');
    const record = InMemoryStore.list('passwordResets').find((item) => item.token === token);
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
    InMemoryStore.remove('passwordResets', record.id);
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
