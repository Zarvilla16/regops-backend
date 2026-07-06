import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.use(helmet());

  const configService = app.get(ConfigService);
  app.enableCors({
    origin: configService.get<string[]>("corsOrigins"),
    credentials: true,
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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

