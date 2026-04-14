import { type DynamicModule, Module } from '@nestjs/common';
import { SESSION_COOKIE_MAX_AGE_SEC } from '../auth/auth.module';
import {
  SESSION_GUARD_CONFIG,
  SessionGuard,
  type SessionGuardConfig,
} from '../common/session.guard';
import type { Env } from '../config/env';
import { DigestsRepo } from '../workers/digests.repo';
import { DigestsController } from './digests.controller';
import { DigestsService } from './digests.service';

/**
 * Wires the `/digests` HTTP surface.
 *
 * `forRoot(env)` so the session-guard config (HMAC secret) is bound
 * once at boot — same pattern as `UsersModule.forRoot(env)`. Both
 * modules MUST read from the same `SESSION_SECRET` so a cookie
 * signed on the auth side verifies on either feature module.
 *
 * Providers:
 *   - `DigestsService`        — list / getById / enqueueRunNow.
 *   - `DigestsController`     — HTTP boundary.
 *   - `DigestsRepo`           — re-provided locally; the repo lives
 *                               under `src/workers/` so the processor
 *                               can use it too, and `WorkersModule`
 *                               exports it for cross-module reuse.
 *                               Declaring it here as well keeps the
 *                               DI graph for this module explicit
 *                               even when a future test harness
 *                               imports `DigestsModule` in isolation.
 *   - `SessionGuard`          — gate on all three routes.
 *   - `SESSION_GUARD_CONFIG`  — value provider holding the HMAC secret.
 *
 * The `BUILD_DIGEST_QUEUE` token that `DigestsService` injects lives
 * in the `@Global()` `QueueModule`, so it doesn't need to be
 * re-imported here.
 */
@Module({})
export class DigestsModule {
  static forRoot(env: Env): DynamicModule {
    const sessionGuardConfig: SessionGuardConfig = {
      sessionSecret: env.SESSION_SECRET,
      sessionMaxAgeSec: SESSION_COOKIE_MAX_AGE_SEC,
    };

    return {
      module: DigestsModule,
      controllers: [DigestsController],
      providers: [
        DigestsService,
        DigestsRepo,
        SessionGuard,
        {
          provide: SESSION_GUARD_CONFIG,
          useValue: sessionGuardConfig,
        },
      ],
      exports: [DigestsService],
    };
  }
}
