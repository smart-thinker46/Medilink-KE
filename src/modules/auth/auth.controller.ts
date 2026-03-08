import { Body, Controller, Post, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleAuthDto, LoginUserDto, RegisterUserDto } from './dto/auth.dto';
import type { Request } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  private getClientIp(req: Request) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0]?.trim() || null;
    }
    if (Array.isArray(forwarded) && forwarded.length) {
      return String(forwarded[0] || '').split(',')[0]?.trim() || null;
    }
    return req.ip || null;
  }

  @Post('register')
  async register(@Body() dto: RegisterUserDto) {
    return this.authService.register(dto);
  }

  // Frontend expects /api/auth/signup
  @Post('signup')
  async signup(@Body() dto: RegisterUserDto) {
    return this.authService.register(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() dto: LoginUserDto, @Req() req: Request) {
    return this.authService.login(dto, this.getClientIp(req));
  }

  @HttpCode(HttpStatus.OK)
  @Post('google')
  async googleContinue(@Body() dto: GoogleAuthDto) {
    return this.authService.googleContinue(dto);
  }

  @Post('password/forgot')
  async forgotPassword(@Body() body: { email: string }, @Req() req: Request) {
    return this.authService.requestPasswordReset(body.email, this.getClientIp(req));
  }

  @Post('forgot-password')
  async forgotPasswordAlias(@Body() body: { email: string }, @Req() req: Request) {
    return this.authService.requestPasswordReset(body.email, this.getClientIp(req));
  }

  @Post('password/reset')
  async resetPassword(@Body() body: { token: string; password: string }) {
    return this.authService.resetPassword(body.token, body.password);
  }

  @Post('reset-password')
  async resetPasswordAlias(@Body() body: { token: string; password: string }) {
    return this.authService.resetPassword(body.token, body.password);
  }
}
