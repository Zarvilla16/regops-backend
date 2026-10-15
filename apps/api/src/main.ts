import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { initSentry } from "./common/observability/sentry";

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.use(helmet());

  // Express's default json() body limit (100kb) rejects a legitimate
  // 1000-transaction webhook batch (spec Section 6.1's own max) before it
  // ever reaches IngestWebhookDto's validation, surfacing as an opaque 500
  // instead of the intended 400. Raised, not removed — still bounded.
  // useBodyParser (not a second app.use(express.json())) preserves the
  // rawBody capture WebhookSignatureGuard depends on (see bootstrap()).
  (app as NestExpressApplication).useBodyParser("json", { limit: "5mb" });

  const configService = app.get(ConfigService);
  app.enableCors({
    origin: configService.get<string[]>("corsOrigins"),
    credentials: true,
  });
}

async function bootstrap(): Promise<void> {
  // rawBody: true also populates req.rawBody (alongside the normal parsed
  // req.body) for every request — needed by WebhookSignatureGuard to verify
  // an HMAC computed over the exact bytes the sender signed (Backend Prompt
  // 4, Section 6.2); every other route's body handling is unaffected.
  initSentry("regops-api");
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  const configService = app.get(ConfigService);

  if (configService.get<string>("nodeEnv") !== "production") {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("RegOps API")
      .setDescription("Multi-tenant AML/CFT compliance platform API")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("docs", app, document);
  }

  app.enableShutdownHooks();

  if (configService.get<string>("nodeEnv") === "production" && /localhost|127\.0\.0\.1/.test(configService.get<string>("frontendUrl") ?? "")) {
    console.warn(
      "WARNING: FRONTEND_URL / CORS_ORIGINS point at localhost; invite and password-reset links will not work. Set FRONTEND_URL.",
    );
  }

  const port = configService.get<number>("port") ?? 4000;
  await app.listen(port);
  console.log(`RegOps API listening on port ${port}`);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error("API failed to start:", err);
    process.exit(1);
  });
}

