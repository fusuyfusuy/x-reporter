import { Module, type DynamicModule } from '@nestjs/common';
import { AppwriteModule } from './appwrite/appwrite.module';
import { AuthModule } from './auth/auth.module';
import { LoggerModule } from './common/logger';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';

/**
 * The application root module.
 *
 * Use `AppModule.forRoot()` from `main.ts` so the env is loaded once at boot
 * and passed into modules that need to be configured at construction time
 * (`LoggerModule`, `AppwriteModule`, `AuthModule`).
 *
 * Future modules (Users /me routes, Ingestion, ...) plug in here as they land.
 */
@Module({})
export class AppModule {
  static forRoot(): DynamicModule {
    const env = loadEnv();
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(env),
        AppwriteModule.forRoot(env),
        HealthModule,
        AuthModule.forRoot(env),
      ],
    };
  }
}
