import { Module, type DynamicModule } from '@nestjs/common';
import { AppwriteModule } from './appwrite/appwrite.module';
import { AuthModule } from './auth/auth.module';
import { LoggerModule } from './common/logger';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { ScheduleModule } from './schedule/schedule.module';
import { UsersModule } from './users/users.module';
import { UsersRepoModule } from './users/users-repo.module';

/**
 * The application root module.
 *
 * Use `AppModule.forRoot()` from `main.ts` so the env is loaded once at boot
 * and passed into modules that need to be configured at construction time
 * (`LoggerModule`, `AppwriteModule`, `QueueModule`, `AuthModule`,
 * `UsersModule`).
 *
 * Module registration order:
 *   1. Foundations: `LoggerModule`, `AppwriteModule`, `QueueModule`.
 *   2. Shared leaf adapters: `UsersRepoModule` (global; provides
 *      `UsersRepo` process-wide so both `ScheduleService` and
 *      `AuthService` / `UsersService` can inject it without duplicate
 *      providers).
 *   3. Cross-cutting: `ScheduleModule` (registered as `@Global()` so any
 *      consumer can inject `ScheduleService` without re-importing).
 *   4. Feature modules: `HealthModule`, `AuthModule`, `UsersModule`.
 *
 * `QueueModule.forRoot({ redisUrl })` is where the process-wide BullMQ
 * queues and the shared ioredis client are constructed. It must come
 * before `ScheduleModule` because `ScheduleService` injects queue
 * tokens from `QueueModule`.
 *
 * `UsersRepoModule` must come before `ScheduleModule` because
 * `ScheduleService` injects `UsersRepo` in its constructor — the
 * provider has to be visible in Nest's DI container by the time
 * `ScheduleModule` is being instantiated.
 *
 * `AuthModule.forRoot(env)` runs after `ScheduleModule` because
 * `AuthService` injects `ScheduleService` via the global container.
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
        QueueModule.forRoot({ redisUrl: env.REDIS_URL }),
        UsersRepoModule,
        ScheduleModule,
        HealthModule,
        AuthModule.forRoot(env),
        UsersModule.forRoot(env),
      ],
    };
  }
}
