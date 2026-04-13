import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from '../../config/env';
import { createLlmProvider } from './index';

/**
 * DI token for the `LlmProvider` port. Consumers inject the provider
 * via `@Inject(LLM_PROVIDER)` without referencing the concrete class.
 *
 * Follows the same naming convention as `X_SOURCE` in
 * `src/ingestion/ingestion.module.ts` and `X_OAUTH_CLIENT` in
 * `src/auth/auth.module.ts`.
 */
export const LLM_PROVIDER = 'LlmProvider';

/**
 * Wires the LLM provider into the NestJS DI container.
 *
 * `forRoot(env)` builds the concrete adapter once via `createLlmProvider`
 * and exposes it under the `LLM_PROVIDER` token. The digest graph nodes
 * (milestone #10+) inject this token to call the LLM without knowing
 * which vendor is behind it.
 */
@Module({})
export class LlmModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: LlmModule,
      providers: [
        {
          provide: LLM_PROVIDER,
          useFactory: () => createLlmProvider(env),
        },
      ],
      exports: [LLM_PROVIDER],
    };
  }
}
