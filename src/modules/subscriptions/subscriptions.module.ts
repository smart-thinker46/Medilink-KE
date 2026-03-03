import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { EmailsModule } from '../emails/emails.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionReminderService } from './subscription-reminder.service';

@Module({
  imports: [EmailsModule, NotificationsModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionReminderService],
})
export class SubscriptionsModule {}
