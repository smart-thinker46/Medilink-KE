import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { PatientsModule } from './modules/patients/patients.module';
import { UsersModule } from './modules/users/users.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { MedicsModule } from './modules/medics/medics.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PharmacyModule } from './modules/pharmacy/pharmacy.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { EmailsModule } from './modules/emails/emails.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { VideoCallsModule } from './modules/video-calls/video-calls.module';
import { MedicalRecordsModule } from './modules/medical-records/medical-records.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { AdminModule } from './modules/admin/admin.module';
import { ComplaintsModule } from './modules/complaints/complaints.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { MessagesModule } from './modules/messages/messages.module';
import { AiModule } from './modules/ai/ai.module';
import { HospitalServicesModule } from './modules/hospital-services/hospital-services.module';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { ProfileExtrasBackfillService } from './common/profile-extras-backfill.service';
import { SubscriptionAccessService } from './common/subscription-access.service';
import { SubscriptionAccessInterceptor } from './common/subscription-access.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    ThrottlerModule.forRoot([{
      ttl: 900000, // 15 mins
      limit: 100,
    }]),
    DatabaseModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...(function () {
          const redisUrlRaw = String(config.get('REDIS_URL') || '').trim();
          const redisUrl = (() => {
            if (!redisUrlRaw) return '';
            // Accept accidentally pasted CLI commands like:
            // "redis-cli -u redis://default:pass@host:port"
            const redissIndex = redisUrlRaw.indexOf('rediss://');
            if (redissIndex >= 0) return redisUrlRaw.slice(redissIndex).trim();
            const redisIndex = redisUrlRaw.indexOf('redis://');
            if (redisIndex >= 0) return redisUrlRaw.slice(redisIndex).trim();
            return redisUrlRaw;
          })();
          if (redisUrl) {
            try {
              const parsed = new URL(redisUrl);
              return {
                connection: {
                  host: parsed.hostname,
                  port: Number(parsed.port || 6379),
                  username: parsed.username || undefined,
                  password: parsed.password || undefined,
                  ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
                },
              };
            } catch {
              console.warn(
                '[Redis] Invalid REDIS_URL format. Falling back to REDIS_HOST/REDIS_PORT.',
              );
            }
          }
          const redisHostRaw = String(config.get('REDIS_HOST') || '').trim();
          const redisPassword = String(config.get('REDIS_PASSWORD') || '').trim();
          const redisUsername = String(config.get('REDIS_USERNAME') || '').trim();
          const redisTls = String(config.get('REDIS_TLS') || 'false') === 'true';

          if (redisHostRaw.startsWith('redis://') || redisHostRaw.startsWith('rediss://')) {
            try {
              const parsed = new URL(redisHostRaw);
              return {
                connection: {
                  host: parsed.hostname,
                  port: Number(parsed.port || config.get('REDIS_PORT') || 6379),
                  username: parsed.username || redisUsername || undefined,
                  password: parsed.password || redisPassword || undefined,
                  ...(parsed.protocol === 'rediss:' || redisTls ? { tls: {} } : {}),
                },
              };
            } catch {
              // Fall through to plain host/port config below.
            }
          }

          return {
            connection: {
              host: redisHostRaw || config.get('REDIS_HOST'),
              port: Number(config.get('REDIS_PORT') || 6379),
              username: redisUsername || undefined,
              password: redisPassword || undefined,
              ...(redisTls ? { tls: {} } : {}),
            },
          };
        })(),
      }),
    }),
    AuthModule,
    TenantsModule,
    PatientsModule,
    UsersModule,
    AppointmentsModule,
    MedicsModule,
    ShiftsModule,
    JobsModule,
    OrdersModule,
    PharmacyModule,
    PaymentsModule,
    EmailsModule,
    NotificationsModule,
    VideoCallsModule,
    MedicalRecordsModule,
    UploadsModule,
    AdminModule,
    ComplaintsModule,
    SubscriptionsModule,
    MessagesModule,
    AiModule,
    HospitalServicesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    ProfileExtrasBackfillService,
    SubscriptionAccessService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SubscriptionAccessInterceptor,
    },
  ],
})
export class AppModule {}
