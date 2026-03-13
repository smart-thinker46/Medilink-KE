import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  getConfiguredAiVoiceModels,
  resolveAiVoiceModel,
} from 'src/common/ai-voice-models';

type ProcessRunOptions = {
  stdin?: string;
  timeoutMs?: number;
};

type ProcessRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

@Injectable()
export class AiLocalVoiceService {
  private readonly logger = new Logger(AiLocalVoiceService.name);

  private readonly piperBin = String(process.env.PIPER_BIN || 'piper').trim();
  private readonly piperModel = String(process.env.PIPER_MODEL || '').trim();
  private readonly whisperBin = String(process.env.WHISPER_CPP_BIN || 'whisper-cli').trim();
  private readonly whisperModel = String(process.env.WHISPER_CPP_MODEL || '').trim();

  getConfiguredVoices() {
    return getConfiguredAiVoiceModels(process.env);
  }

  getDefaultTtsModel() {
    return resolveAiVoiceModel('', this.getConfiguredVoices(), this.piperModel);
  }

  private async runProcess(
    command: string,
    args: string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessRunResult> {
    return new Promise<ProcessRunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = options.timeoutMs ?? 120000;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          code: Number(code ?? -1),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      if (options.stdin) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    });
  }

  private async probeBinary(command: string) {
    try {
      const result = await this.runProcess(command, ['--help'], { timeoutMs: 4000 });
      return result.code === 0 || result.code === 1;
    } catch {
      return false;
    }
  }

  private ensureText(value: unknown) {
    const text = String(value || '').trim();
    if (!text) throw new BadRequestException('Text is required for TTS.');
    if (text.length > 2000) {
      throw new BadRequestException('Text too long for one TTS request (max 2000 chars).');
    }
    return this.normalizeTtsText(text);
  }

  private normalizeTtsText(text: string) {
    // Improve pronunciation for brand terms across the system.
    return String(text)
      .replace(/\bmedilink\b/gi, 'Medi link')
      .trim();
  }

  private normalizeSpeed(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(Math.max(numeric, 0.6), 1.4);
  }

  private ensureUploadDir(...parts: string[]) {
    const dir = join(process.cwd(), 'uploads', ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private ensurePiperModel(model?: string) {
    const resolved = resolveAiVoiceModel(model, this.getConfiguredVoices(), this.piperModel);
    if (!resolved) {
      throw new BadRequestException(
        'Local TTS is not configured. Set PIPER_MODEL in backend .env.',
      );
    }
    // Piper expects the .onnx file path; strip any accidental .json suffixes.
    if (/\.onnx(\.json)+$/i.test(resolved)) {
      return resolved.replace(/(\.json)+$/i, '');
    }
    return resolved;
  }

  private ensureWhisperModel(model?: string) {
    const resolved = String(model || this.whisperModel || '').trim();
    if (!resolved) {
      throw new BadRequestException(
        'Local STT is not configured. Set WHISPER_CPP_MODEL in backend .env.',
      );
    }
    return resolved;
  }

  private getWhisperLanguageSupport(modelPath: string) {
    const modelName = basename(String(modelPath || '')).toLowerCase();
    const englishOnly = /\.en\./.test(modelName) || modelName.endsWith('.en.bin');
    return {
      englishOnly,
      availableLanguages: englishOnly ? ['en'] : ['auto (multilingual whisper model)'],
      notes: englishOnly
        ? 'Current Whisper model is English-only.'
        : 'Current Whisper model supports multilingual transcription.',
    };
  }

  async getStatus() {
    const piperAvailable = await this.probeBinary(this.piperBin);
    const whisperAvailable = await this.probeBinary(this.whisperBin);
    const support = this.getWhisperLanguageSupport(this.whisperModel);
    const voiceOptions = this.getConfiguredVoices();
    const defaultVoiceModel = resolveAiVoiceModel('', voiceOptions, this.piperModel);
    return {
      provider: 'medilink-local-voice',
      tts: {
        engine: 'piper',
        binary: this.piperBin,
        binaryAvailable: piperAvailable,
        model: this.piperModel || null,
        defaultModel: defaultVoiceModel || null,
        configured: Boolean(this.piperModel),
        options: voiceOptions,
      },
      stt: {
        engine: 'whisper.cpp',
        binary: this.whisperBin,
        binaryAvailable: whisperAvailable,
        model: this.whisperModel || null,
        configured: Boolean(this.whisperModel),
        languageSupport: support,
      },
      ready:
        piperAvailable &&
        whisperAvailable &&
        Boolean(this.piperModel) &&
        Boolean(this.whisperModel),
      checkedAt: new Date().toISOString(),
    };
  }

  async synthesize(payload: any) {
    const text = this.ensureText(payload?.text);
    const model = this.ensurePiperModel(payload?.model);
    const speed = this.normalizeSpeed(payload?.speed);
    const outputDir = join(tmpdir(), 'medilink-ai-voice', 'tts');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${randomUUID()}.wav`);

    try {
      const args = ['--model', model, '--output_file', outputPath];
      if (speed && speed !== 1) {
        const lengthScale = (1 / speed).toFixed(3);
        args.push('--length_scale', lengthScale);
      }
      let result = await this.runProcess(this.piperBin, args, {
        stdin: text,
        timeoutMs: 180000,
      });

      if (result.code !== 0 && speed) {
        // Retry without speed if the binary doesn't support the flag.
        result = await this.runProcess(this.piperBin, ['--model', model, '--output_file', outputPath], {
          stdin: text,
          timeoutMs: 180000,
        });
      }

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'Piper exited with non-zero code.');
      }
      if (!existsSync(outputPath)) {
        throw new Error('Piper finished but output file was not created.');
      }

      const stat = await fsp.stat(outputPath);
      if (!stat.size) {
        throw new Error('Generated audio file is empty.');
      }
      const audioBuffer = await fsp.readFile(outputPath);
      const audioBase64 = audioBuffer.toString('base64');

      return {
        engine: 'piper',
        mimeType: 'audio/wav',
        bytes: stat.size,
        audioBase64,
        speed: speed || 1,
        generatedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(
        `Piper TTS failed: ${String(error?.message || error)}`,
        error?.stack || undefined,
      );
      throw new InternalServerErrorException(
        `Local TTS failed. Confirm Piper is installed and PIPER_MODEL is valid. ${String(
          error?.message || '',
        ).trim()}`,
      );
    } finally {
      // Ensure no server-side file is retained after response generation.
      await fsp.rm(outputPath, { force: true }).catch(() => undefined);
    }
  }

  async transcribe(filePath: string, payload: any = {}) {
    if (!filePath || !existsSync(filePath)) {
      throw new BadRequestException('Audio file is required for STT.');
    }

    const model = this.ensureWhisperModel(payload?.model);
    const language = String(payload?.language || '').trim();
    const translateFlag = String(payload?.translate ?? '')
      .trim()
      .toLowerCase();
    const translate =
      payload?.translate === true ||
      translateFlag === 'true' ||
      translateFlag === '1' ||
      String(payload?.task || '').trim().toLowerCase() === 'translate';
    const support = this.getWhisperLanguageSupport(model);
    const outputDir = this.ensureUploadDir('ai-voice', 'stt');
    const outputBase = join(outputDir, randomUUID());
    const outputTxt = `${outputBase}.txt`;

    try {
      const args = ['-m', model, '-f', filePath, '-otxt', '-of', outputBase];
      if (language) {
        args.push('-l', language);
      }
      if (translate) {
        args.push('-tr');
      }

      const result = await this.runProcess(this.whisperBin, args, {
        timeoutMs: 180000,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'whisper.cpp exited with non-zero code.');
      }

      let transcript = '';
      if (existsSync(outputTxt)) {
        transcript = String(await fsp.readFile(outputTxt, 'utf8')).trim();
      }
      if (!transcript) {
        transcript = result.stdout;
      }
      transcript = String(transcript || '').trim();
      if (!transcript) {
        throw new Error('No transcript returned by whisper.cpp.');
      }

      return {
        engine: 'whisper.cpp',
        text: transcript,
        language: language || 'auto',
        translated: translate,
        languageSupport: support,
        generatedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(
        `whisper.cpp STT failed: ${String(error?.message || error)}`,
        error?.stack || undefined,
      );
      throw new InternalServerErrorException(
        `Local STT failed. Confirm whisper.cpp is installed and WHISPER_CPP_MODEL is valid. ${String(
          error?.message || '',
        ).trim()}`,
      );
    } finally {
      // Cleanup temporary input/output artifacts.
      await Promise.allSettled([
        fsp.rm(filePath, { force: true }),
        fsp.rm(outputTxt, { force: true }),
      ]);
    }
  }
}
