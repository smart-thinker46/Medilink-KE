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
        connection: {
          host: config.get('REDIS_HOST'),
          port: config.get('REDIS_PORT'),
        },
      }),
    }),
    AuthModule,
    TenantsModule,
    PatientsModule,
    UsersModule,
    AppointmentsModule,
    MedicsModule,
    ShiftsModule,
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
