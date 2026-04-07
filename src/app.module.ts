import { Module, type DynamicModule } from '@nestjs/common';
import { AppwriteModule } from './appwrite/appwrite.module';
import { AuthModule } from './auth/auth.module';
import { LoggerModule } from './common/logger';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { ScheduleModule } from './schedule/schedule.module';
import { UsersModule } from './users/users.module';

/**
 * The application root module.
 *
 * Use `AppModule.forRoot()` from `main.ts` so the env is loaded once at boot
 * and passed into modules that need to be configured at construction time
 * (`LoggerModule`, `AppwriteModule`, `AuthModule`, `UsersModule`).
 *
 * Module registration order:
 *   1. Foundations: `LoggerModule`, `AppwriteModule`.
 *   2. Cross-cutting: `ScheduleModule` (registered as `@Global()` so any
 *      consumer can inject `ScheduleService` without re-importing).
 *   3. Feature modules: `HealthModule`, `AuthModule`, `UsersModule`.
 *
 * `ScheduleModule` is currently the milestone-#4 stub
 * (`src/schedule/schedule.service.ts`). Milestone #5 will replace its
 * single method's body with the real BullMQ implementation; the
 * registration here does not change.
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
        ScheduleModule,
        HealthModule,
        AuthModule.forRoot(env),
        UsersModule.forRoot(env),
      ],
    };
  }
}
