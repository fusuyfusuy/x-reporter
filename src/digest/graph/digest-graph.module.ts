/**
 * NestJS wiring for `DigestGraph`.
 *
 * Declared `@Global()` so feature modules (notably the #11 `build-digest`
 * processor) can inject `DigestGraph` without re-importing this module.
 * The graph itself is a thin façade over LangGraph; the real provider
 * composition happens inside `DigestGraph` via the injected `LlmProvider`.
 */
import { Global, Module } from '@nestjs/common';
import type { LlmProvider } from '../llm/llm-provider.interface';
import { LLM_PROVIDER } from '../llm/llm.tokens';
import { DigestGraph } from './digest.graph';

@Global()
@Module({
  providers: [
    {
      provide: DigestGraph,
      inject: [LLM_PROVIDER],
      useFactory: (llm: LlmProvider) => new DigestGraph(llm),
    },
  ],
  exports: [DigestGraph],
})
export class DigestGraphModule {}
