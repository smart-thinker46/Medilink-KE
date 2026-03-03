import { Body, Controller, Headers, Post } from '@nestjs/common';
import { AiVapiService } from './ai-vapi.service';

@Controller('ai/voice')
export class AiVoiceWebhookController {
  constructor(private readonly voice: AiVapiService) {}

  @Post('webhook')
  async webhook(@Body() body: any, @Headers() headers: Record<string, any>) {
    return this.voice.handleWebhook(body || {}, headers || {});
  }
}

