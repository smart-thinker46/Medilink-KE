import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
  Req,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

const resolveUploadExtension = (file: any) => {
  const originalExt = extname(String(file?.originalname || '')).toLowerCase();
  if (originalExt) return originalExt;

  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('msword')) return '.doc';
  if (mime.includes('wordprocessingml')) return '.docx';
  return '';
};

@Controller('uploads')
export class UploadsController {
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'document', maxCount: 1 },
        { name: 'upload', maxCount: 1 },
      ],
      {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const uploadDir = join(process.cwd(), 'uploads');
          mkdirSync(uploadDir, { recursive: true });
          cb(null, uploadDir);
        },
        filename: (_req, file, cb) => {
          const safeOriginalName =
            typeof file?.originalname === 'string' && file.originalname.trim()
              ? file.originalname
              : 'upload.bin';
          const extension = resolveUploadExtension({ ...file, originalname: safeOriginalName });
          const unique = `${randomUUID()}${extension}`;
          cb(null, unique);
        },
      }),
      },
    ),
  )
  async upload(@UploadedFiles() files: Record<string, any[]>, @Req() req: any, @Body() body: any) {
    const file =
      files?.file?.[0] ||
      files?.document?.[0] ||
      files?.upload?.[0] ||
      null;

    if (!file?.filename) {
      const contentType = req?.headers?.['content-type'] || '';
      const bodyKeys = body && typeof body === 'object' ? Object.keys(body) : [];
      throw new BadRequestException(
        `No file uploaded. Use multipart/form-data with field "file". content-type="${contentType}" bodyKeys=${JSON.stringify(bodyKeys)}`,
      );
    }
    return { url: `/uploads/${file.filename}` };
  }
}
