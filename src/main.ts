import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ApiKeysModule } from '@modules/api-keys/api-keys.module';
import { VerificationsModule } from '@modules/verifications/verifications.module';
import { WebhooksModule } from '@modules/webhooks/webhooks.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // ── Security ─────────────────────────────────────────────────────────────
  app.use(helmet());
  app.enableCors();

  // ── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix('api');

  // ── Validation ────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── Swagger ───────────────────────────────────────────────────────────────

  // Public filtered spec (only developer-facing endpoints) — always on so
  // GitBook and external tools can fetch it in all environments.
  const publicSwaggerConfig = new DocumentBuilder()
    .setTitle('Meayar API')
    .setDescription('Developer API for credential verification')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
    .build();
  const publicDocument = SwaggerModule.createDocument(
    app,
    publicSwaggerConfig,
    {
      include: [ApiKeysModule, VerificationsModule, WebhooksModule],
    },
  );
  // Serve JSON at /api/docs/json (used by GitBook OpenAPI block)
  app
    .getHttpAdapter()
    .get('/api/public-docs/json', (_req, res: { json: (d: unknown) => void }) =>
      res.json(publicDocument),
    );

  // Internal full spec — only exposed in non-production
  if (config.get<string>('app.nodeEnv') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Innobyte Trust API (Internal)')
      .setDescription('Full internal API — all endpoints')
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/docs/json',
    });
  }

  const port = config.get<number>('app.port') ?? 8000;
  await app.listen(port);
}

void bootstrap();
