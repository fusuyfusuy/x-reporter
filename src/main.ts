import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

/**
 * Application entry point.
 *
 * 1. Loads & validates env (via AppModule.forRoot -> loadEnv); aborts on
 *    invalid config before binding the HTTP server.
 * 2. Creates the Nest application with `@nestjs/platform-express`.
 * 3. Replaces the default Nest logger with `nestjs-pino` so framework logs
 *    flow through pino with redaction applied.
 * 4. Listens on the validated PORT.
 */
async function bootstrap(): Promise<void> {
  // Load env once outside the dynamic module so we can read PORT for listen()
  // and surface a clear error before NestFactory.create starts initializing.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule.forRoot(), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  await app.listen(env.PORT);

  const logger = app.get(Logger);
  logger.log(`x-reporter listening on http://0.0.0.0:${env.PORT} (env=${env.NODE_ENV})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap x-reporter:', err);
  process.exit(1);
});
