import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import helmet from 'helmet';
import compression from 'compression';
import { winstonLogger } from './common/logger/winston.logger';
import { ZodValidationPipe } from 'nestjs-zod';
import { PrismaService } from './database/prisma.service';
import { InMemoryStore } from './common/in-memory.store';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: winstonLogger,
  });
  // Required behind Render/other reverse proxies so req.ip is the real client IP.
  app.set('trust proxy', 1);

  const corsOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  app.use(helmet());
  app.use(compression());

  app.useGlobalPipes(new ZodValidationPipe());

  app.setGlobalPrefix('api');

  const prisma = app.get(PrismaService);
  await InMemoryStore.hydrate(prisma);
  InMemoryStore.configure(prisma);

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
