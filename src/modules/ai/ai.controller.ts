import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post('health-summary')
  async healthSummary(@Req() req: any, @Body() body: any) {
    return this.aiService.summarizeHealthStatus(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('search')
  async search(@Req() req: any, @Body() body: any) {
    return this.aiService.smartSearch(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('analytics-summary')
  async analyticsSummary(@Req() req: any, @Body() body: any) {
    return this.aiService.analyticsSummary(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('assistant')
  async assistant(@Req() req: any, @Body() body: any) {
    return this.aiService.assistantChat(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('appointment-copilot')
  async appointmentCopilot(@Req() req: any, @Body() body: any) {
    return this.aiService.appointmentCopilot(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('medical-record-summary')
  async medicalRecordSummary(@Req() req: any, @Body() body: any) {
    return this.aiService.summarizeHealthStatus(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('medication-safety')
  async medicationSafety(@Req() req: any, @Body() body: any) {
    return this.aiService.medicationSafety(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('stock-forecast')
  async stockForecast(@Req() req: any, @Body() body: any) {
    return this.aiService.stockForecastCopilot(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('app-help')
  async appHelp(@Req() req: any, @Body() body: any) {
    return this.aiService.appHelp(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('knowledge-help')
  async knowledgeHelp(@Req() req: any, @Body() body: any) {
    return this.aiService.knowledgeHelp(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('help-desk')
  async helpDesk(@Req() req: any, @Body() body: any) {
    return this.aiService.helpDesk(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('admin/ops-copilot')
  async adminOpsCopilot(@Req() req: any, @Body() body: any) {
    return this.aiService.helpDesk(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('translate')
  async translate(@Req() req: any, @Body() body: any) {
    return this.aiService.translateText(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('chat-assist')
  async chatAssist(@Req() req: any, @Body() body: any) {
    return this.aiService.chatAssist(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('admin/users-assistant')
  async adminUsersAssistant(@Req() req: any, @Body() body: any) {
    return this.aiService.adminUsersAssistant(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('admin/emails-assistant')
  async adminEmailsAssistant(@Req() req: any, @Body() body: any) {
    return this.aiService.adminEmailAssistant(body, req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('settings')
  async settings(@Req() req: any) {
    return this.aiService.getSettings(req.user);
  }

  @UseGuards(AuthGuard('jwt'))
  @Put('settings')
  async updateSettings(@Req() req: any, @Body() body: any) {
    return this.aiService.updateSettings(req.user, body);
  }

  @Get('health')
  async health() {
    return this.aiService.healthCheck();
  }
}
