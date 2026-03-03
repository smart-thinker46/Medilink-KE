import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiVapiService } from './ai-vapi.service';

@Controller('ai/voice')
@UseGuards(AuthGuard('jwt'))
export class AiVoiceController {
  constructor(private readonly voice: AiVapiService) {}

  @Post('session')
  async createSession(@Req() req: any, @Body() body: any) {
    return this.voice.createSession(req.user, body || {});
  }

  @Get('history')
  async history(@Req() req: any, @Query() query: any) {
    return this.voice.listHistory(req.user, query || {});
  }

  @Post('tool')
  async executeTool(@Req() req: any, @Body() body: any) {
    return this.voice.executeTool(req.user, body || {});
  }
}

