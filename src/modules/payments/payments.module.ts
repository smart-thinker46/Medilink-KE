import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { MpesaService } from './mpesa.service';
import { MpesaWebhookController } from './webhook.controller';
import { EmailsModule } from '../emails/emails.module';
import { IntaSendService } from './intasend.service';
import { IntaSendWebhookController } from './intasend-webhook.controller';

@Module({
  controllers: [PaymentsController, MpesaWebhookController, IntaSendWebhookController],
  providers: [MpesaService, IntaSendService],
  imports: [EmailsModule],
})
export class PaymentsModule {}
