
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ConfigService } from '@nestjs/config';
import { EmailsModule } from '../emails/emails.module';
import { AuthTransientStore } from './auth-transient.store';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRATION') || '1d' },
      }),
    }),
    EmailsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AuthTransientStore],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
