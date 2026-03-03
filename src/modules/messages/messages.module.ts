import { Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MessagesGateway } from './messages.gateway';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [MessagesController],
  providers: [MessagesGateway],
})
export class MessagesModule {}
