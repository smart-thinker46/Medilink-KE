import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import { InMemoryStore } from './common/in-memory.store';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('client-logs')
  @HttpCode(HttpStatus.ACCEPTED)
  ingestClientLogs(
    @Body() body: any,
    @Headers('authorization') authorization?: string,
    @Headers('x-client-log-key') headerKey?: string,
    @Req() req?: any,
  ) {
    const expectedKey =
      String(this.config.get('CLIENT_LOGS_API_KEY') || this.config.get('CREATE_TEMP_API_KEY') || '').trim();
    if (expectedKey) {
      const bearer =
        String(authorization || '').startsWith('Bearer ')
          ? String(authorization).slice(7).trim()
          : '';
      const providedKey = String(headerKey || bearer || '').trim();
      if (!providedKey || providedKey !== expectedKey) {
        throw new UnauthorizedException('Invalid client log key.');
      }
    }

    const incomingLogs = Array.isArray(body?.logs) ? body.logs : [];
    if (!incomingLogs.length) {
      throw new BadRequestException('logs[] is required.');
    }

    const acceptedLogs = incomingLogs.slice(0, 20).map((entry: any) => ({
      level: String(entry?.level || 'error').toLowerCase(),
      message: String(entry?.message || ''),
      timestamp: String(entry?.timestamp || new Date().toISOString()),
      appVersion: entry?.appVersion ? String(entry.appVersion) : null,
      platform: entry?.platform ? String(entry.platform) : null,
      context: entry?.context && typeof entry.context === 'object' ? entry.context : null,
    }));

    const projectGroupId = String(body?.projectGroupId || '').trim() || null;
    acceptedLogs.forEach((log) => {
      InMemoryStore.create('clientErrorLogs', {
        projectGroupId,
        ...log,
        ip: String(req?.ip || req?.socket?.remoteAddress || '').trim() || null,
        userAgent: String(req?.headers?.['user-agent'] || '').trim() || null,
        createdAt: new Date().toISOString(),
      } as any);
    });

    if (acceptedLogs.length) {
      const sample = acceptedLogs[0];
      this.logger.warn(
        `Client log received (${acceptedLogs.length}) level=${sample?.level} project=${projectGroupId || 'n/a'}`,
      );
    }

    return {
      success: true,
      accepted: acceptedLogs.length,
    };
  }
}
