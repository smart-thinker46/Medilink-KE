import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { EmailsModule } from '../emails/emails.module';
import { IntaSendService } from './intasend.service';
import { IntaSendWebhookController } from './intasend-webhook.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  controllers: [PaymentsController, IntaSendWebhookController],
  providers: [IntaSendService],
  imports: [EmailsModule, NotificationsModule],
})
export class PaymentsModule {}
