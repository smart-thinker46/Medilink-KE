import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { mkdirSync } from 'fs';
import { AiVapiService } from './ai-vapi.service';
import { AiLocalVoiceService } from './ai-local-voice.service';
import { AiService } from './ai.service';

@Controller('ai/voice')
@UseGuards(AuthGuard('jwt'))
export class AiVoiceController {
  constructor(
    private readonly voice: AiVapiService,
    private readonly localVoice: AiLocalVoiceService,
    private readonly aiService: AiService,
  ) {}

  private async ensureVoiceAccess(user: any) {
    const access = await this.aiService.getAccessState(user);
    if (!access?.canUse) {
      throw new BadRequestException(access?.blockedReason || 'AI access denied.');
    }
  }

  @Get('local-status')
  async localStatus() {
    return this.localVoice.getStatus();
  }

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

  @Post('tts')
  async textToSpeech(@Req() req: any, @Body() body: any) {
    await this.ensureVoiceAccess(req.user);
    return this.localVoice.synthesize(body || {});
  }

  @Post('stt')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const uploadDir = join(process.cwd(), 'uploads', 'ai-voice', 'incoming');
          mkdirSync(uploadDir, { recursive: true });
          cb(null, uploadDir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(String(file?.originalname || '')).toLowerCase() || '.wav';
          cb(null, `${randomUUID()}${ext}`);
        },
      }),
      limits: {
        fileSize: 20 * 1024 * 1024,
      },
    }),
  )
  async speechToText(@Req() req: any, @UploadedFile() file: any, @Body() body: any) {
    await this.ensureVoiceAccess(req.user);
    if (!file?.path) {
      throw new BadRequestException('No audio file uploaded. Use multipart/form-data field "file".');
    }
    const payload = body || {};
    const translateFlag = String(payload?.translate ?? '')
      .trim()
      .toLowerCase();
    const requestedTranslate =
      payload?.translate === true ||
      translateFlag === 'true' ||
      translateFlag === '1' ||
      String(payload?.task || '').trim().toLowerCase() === 'translate';
    const targetLanguage = String(payload?.targetLanguage || 'en').trim().toLowerCase() || 'en';

    // whisper.cpp translation mode supports output to English.
    const whisperTranslate = requestedTranslate && targetLanguage === 'en';
    const stt = await this.localVoice.transcribe(file.path, {
      ...payload,
      translate: whisperTranslate,
    });

    if (!requestedTranslate) {
      return {
        ...stt,
        targetLanguage: null,
      };
    }

    if (targetLanguage === 'en') {
      return {
        ...stt,
        translated: true,
        targetLanguage,
        translatedBy: 'whisper.cpp',
      };
    }

    const translated = await this.aiService.translateText(
      {
        text: stt?.text || '',
        sourceLanguage: stt?.language || payload?.language || 'auto',
        targetLanguage,
      },
      req.user,
    );

    return {
      ...stt,
      text: translated.text,
      translated: true,
      targetLanguage,
      translatedBy: translated.provider || 'Medilink AI',
      originalText: translated.originalText || stt?.text || '',
      originalLanguage: stt?.language || payload?.language || 'auto',
    };
  }
}
