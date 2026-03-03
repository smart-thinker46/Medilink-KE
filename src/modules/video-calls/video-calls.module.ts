import { Module } from '@nestjs/common';
import { VideoCallsController } from './video-calls.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [VideoCallsController],
})
export class VideoCallsModule {}
