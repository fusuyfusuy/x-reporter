import { type DynamicModule, Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import type { Env } from '../config/env';
import { UsersRepo } from '../users/users.repo';
import { DEFAULT_FETCH_TIMEOUT_MS, XApiV2Source, type XApiV2SourceConfig } from './x-api-v2.source';
import type { XSource } from './x-source.port';

/**
 * Wires the ingestion module's concrete providers.
 *
 * The module exposes exactly one seam — `X_SOURCE` — backed by the
 * default `XApiV2Source` adapter. The `poll-x` processor in milestone
 * #7 will inject the adapter by token (not by class) so swapping it
 * for a test fake or `XBrowserSource` in the future only requires a
 * factory change here.
 *
 * Why a `forRoot(env)` shape: the X API base URL is sourced from `Env`
 * in milestone #7 when the real BullMQ wiring lands. Today the default
 * `https://api.twitter.com` satisfies acceptance criteria, but keeping
 * the dynamic-module shape means we won't have to reshape `AppModule`
 * later just to inject an override. Tests that want a stubbed adapter
 * override the `X_SOURCE` provider via `Test.overrideProvider`.
 *
 * Providers:
 *
 *   - `X_SOURCE` → factory that builds `XApiV2Source` from
 *     `AuthService` and `UsersRepo`.
 *
 * Dependencies on `AuthModule`:
 *
 *   `AuthService` and `UsersRepo` are injected via the `inject` array
 *   below. They are resolved from the application-wide DI scope because
 *   `AuthModule.forRoot(env)` is registered as `global: true` from
 *   `AppModule`. We deliberately do NOT call `AuthModule.forRoot(env)`
 *   here — doing so would build a second `HttpXOAuthClient` instance
 *   and a duplicate `AuthController` route registration, breaking the
 *   "one auth client per process" contract documented on `AuthModule`.
 *   Tests that load `IngestionModule.forRoot` in isolation must import
 *   `AuthModule.forRoot(env)` themselves as a sibling.
 */

/**
 * DI token for the `XSource` port. Exported so the poll-x processor
 * (#7) and any future consumer can `@Inject(X_SOURCE)` without
 * importing the concrete adapter class. Follows the same naming
 * convention as `X_OAUTH_CLIENT` in `src/auth/auth.module.ts`.
 */
export const X_SOURCE = 'XSource';

/** X API v2 base URL. Centralised here so tests and a future staging env can override it. */
export const X_API_V2_BASE_URL = 'https://api.twitter.com';

@Module({})
export class IngestionModule {
  static forRoot(_env: Env): DynamicModule {
    const config: XApiV2SourceConfig = {
      baseUrl: X_API_V2_BASE_URL,
      fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    };

    const xSourceProvider = {
      provide: X_SOURCE,
      useFactory: (auth: AuthService, users: UsersRepo): XSource =>
        new XApiV2Source(config, auth, users),
      inject: [AuthService, UsersRepo],
    };

    return {
      module: IngestionModule,
      // `global: true` so `WorkersModule` (milestone #7) can inject
      // `X_SOURCE` without re-importing IngestionModule. Same pattern
      // as `AuthModule` and `QueueModule`.
      global: true,
      // No `imports` here: `AuthService` and `UsersRepo` come from the
      // global `AuthModule` registered once by `AppModule`. See the
      // module-level docblock above for why.
      providers: [xSourceProvider],
      exports: [X_SOURCE],
    };
  }
}
