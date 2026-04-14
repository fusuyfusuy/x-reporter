import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from '../../config/env';
import { createLlmProvider } from './llm.factory';
import { LLM_PROVIDER } from './llm.tokens';

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
      // `global: true` so `DigestGraphModule` (#10) and any future consumer
      // can inject `LLM_PROVIDER` without re-importing LlmModule.
      global: true,
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
