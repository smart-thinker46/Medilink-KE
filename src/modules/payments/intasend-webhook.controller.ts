import { Body, Controller, Headers, Post } from '@nestjs/common';
import { IntaSendService } from './intasend.service';

@Controller('payments/intasend')
export class IntaSendWebhookController {
  constructor(private intasend: IntaSendService) {}

  @Post('webhook')
  async webhook(@Body() body: any, @Headers() headers: Record<string, any>) {
    return this.intasend.handleWebhook(body, headers);
  }
}

