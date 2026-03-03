import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiVoiceController } from './ai-voice.controller';
import { AiVoiceWebhookController } from './ai-voice-webhook.controller';
import { AiVapiService } from './ai-vapi.service';
import { AiVoiceToolsService } from './ai-voice-tools.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [AiController, AiVoiceController, AiVoiceWebhookController],
  providers: [AiService, AiVapiService, AiVoiceToolsService],
})
export class AiModule {}
