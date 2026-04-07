import { type DynamicModule, Module } from '@nestjs/common';
import {
  SESSION_GUARD_CONFIG,
  SessionGuard,
  type SessionGuardConfig,
} from '../common/session.guard';
import type { Env } from '../config/env';
import { UsersController } from './users.controller';
import { UsersRepo } from './users.repo';
import { UsersService } from './users.service';

/**
 * Wires the `/me` HTTP surface.
 *
 * Uses `forRoot(env)` so the session-guard config (the HMAC secret
 * the guard verifies cookies against) is bound once at boot. This
 * mirrors the pattern `AuthModule.forRoot(env)` already uses for the
 * same secret on the signing side — `Env` is loaded once at startup
 * and passed into both modules, so the signing and verifying sides
 * always read the same configured `SESSION_SECRET`.
 *
 * Providers:
 *
 *   - `UsersRepo`         — thin Appwrite adapter (already provided
 *     by `AuthModule.forRoot` for the OAuth flow, but registered here
 *     too so `UsersModule` works without `AuthModule` in tests).
 *   - `UsersService`      — orchestrator for the `/me` flow.
 *   - `SessionGuard`      — gate on both routes.
 *   - `SESSION_GUARD_CONFIG` — value provider holding the HMAC secret.
 *
 * `ScheduleService` is NOT provided here. It's exported by
 * `ScheduleModule` (registered as `@Global()` from `AppModule`), so
 * Nest's DI resolves it for `UsersService` automatically in the full
 * application. Tests that instantiate `UsersModule.forRoot(env)` in
 * isolation must also import `ScheduleModule` (or override
 * `ScheduleService` directly). Keeping the schedule wiring out of
 * this module is what lets milestone #5 swap in the real BullMQ
 * implementation without touching this file.
 */
@Module({})
export class UsersModule {
  static forRoot(env: Env): DynamicModule {
    const sessionGuardConfig: SessionGuardConfig = {
      sessionSecret: env.SESSION_SECRET,
    };

    return {
      module: UsersModule,
      controllers: [UsersController],
      providers: [
        UsersRepo,
        UsersService,
        SessionGuard,
        {
          provide: SESSION_GUARD_CONFIG,
          useValue: sessionGuardConfig,
        },
      ],
      exports: [UsersService, UsersRepo],
    };
  }
}
