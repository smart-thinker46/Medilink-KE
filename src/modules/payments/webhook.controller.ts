import { Controller, Post, Body } from '@nestjs/common';
import { MpesaService } from './mpesa.service';

@Controller('payments/mpesa')
export class MpesaWebhookController {
  constructor(private mpesa: MpesaService) {}

  @Post('callback')
  async callback(@Body() body: any) {
    return this.mpesa.handleCallback(body);
  }
}
