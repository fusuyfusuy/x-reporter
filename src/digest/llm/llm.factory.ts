import type { Env } from '../../config/env';
import type { LlmProvider } from './llm-provider.interface';
import { OpenRouterProvider } from './openrouter.provider';

/**
 * Factory that returns the concrete `LlmProvider` selected by
 * `env.LLM_PROVIDER`. Called once at boot by `LlmModule.forRoot`.
 */
export function createLlmProvider(env: Env): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  }
}
