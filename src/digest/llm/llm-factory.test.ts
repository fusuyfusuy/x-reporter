import { describe, expect, it, mock } from 'bun:test';

// Mock langchain before importing factory
mock.module('@langchain/openai', () => ({
  ChatOpenAI: class FakeChatOpenAI {
    bind() {
      return { invoke: async () => ({ content: '', response_metadata: {} }) };
    }
  },
}));

mock.module('@langchain/core/messages', () => ({
  SystemMessage: class {},
  HumanMessage: class {},
  AIMessage: class {},
}));

const { createLlmProvider } = await import('./index');
const { OpenRouterProvider } = await import('./openrouter.provider');

/** Minimal Env stub — only the fields `createLlmProvider` reads. */
function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'sk-test',
    OPENROUTER_MODEL: 'anthropic/claude-sonnet-4.5',
    ...overrides,
  } as Parameters<typeof createLlmProvider>[0];
}

describe('createLlmProvider', () => {
  it('returns an OpenRouterProvider when LLM_PROVIDER is "openrouter"', () => {
    const provider = createLlmProvider(makeEnv());
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('throws for an unknown provider', () => {
    expect(() => createLlmProvider(makeEnv({ LLM_PROVIDER: 'nope' }))).toThrow(
      'Unknown LLM_PROVIDER: nope',
    );
  });
});
