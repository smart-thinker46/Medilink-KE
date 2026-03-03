import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';

@Controller('ai')
@UseGuards(AuthGuard('jwt'))
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('health-summary')
  async healthSummary(@Req() req: any, @Body() body: any) {
    return this.aiService.summarizeHealthStatus(body, req.user);
  }

  @Post('search')
  async search(@Req() req: any, @Body() body: any) {
    return this.aiService.smartSearch(body, req.user);
  }

  @Post('analytics-summary')
  async analyticsSummary(@Req() req: any, @Body() body: any) {
    return this.aiService.analyticsSummary(body, req.user);
  }

  @Post('assistant')
  async assistant(@Req() req: any, @Body() body: any) {
    return this.aiService.quickAssistant(body, req.user);
  }

  @Get('settings')
  async settings(@Req() req: any) {
    return this.aiService.getSettings(req.user);
  }

  @Put('settings')
  async updateSettings(@Req() req: any, @Body() body: any) {
    return this.aiService.updateSettings(req.user, body);
  }

  @Get('health')
  async health() {
    return { ok: true, service: 'ai' };
  }
}
