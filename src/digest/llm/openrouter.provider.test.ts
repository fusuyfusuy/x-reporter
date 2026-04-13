import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChatOptions } from './llm-provider.interface';

/**
 * Unit tests for `OpenRouterProvider`.
 *
 * Strategy: mock the `@langchain/openai` `ChatOpenAI` class at the module
 * level so no HTTP call leaves the process. The mock captures constructor
 * args and `.bind().invoke()` calls, then returns a canned response that
 * mirrors what OpenRouter / LangChain would produce.
 */

// --- Mock setup --------------------------------------------------------

const invokeResult = {
  content: 'Hello from the LLM',
  response_metadata: {
    usage: {
      prompt_tokens: 42,
      completion_tokens: 17,
    },
  },
};

let capturedCtorArgs: unknown;
let capturedBindArgs: unknown;
let capturedInvokeArgs: unknown;

// biome-ignore lint/suspicious/noExplicitAny: test mock needs flexible typing
const fakeInvoke = mock(async (msgs: unknown): Promise<any> => {
  capturedInvokeArgs = msgs;
  return invokeResult;
});

const fakeBind = mock((args: unknown) => {
  capturedBindArgs = args;
  return { invoke: fakeInvoke };
});

class FakeChatOpenAI {
  constructor(args: unknown) {
    capturedCtorArgs = args;
  }
  bind = fakeBind;
}

// Mock the langchain module before importing the provider
mock.module('@langchain/openai', () => ({
  ChatOpenAI: FakeChatOpenAI,
}));

mock.module('@langchain/core/messages', () => ({
  SystemMessage: class SystemMessage {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
  HumanMessage: class HumanMessage {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
  AIMessage: class AIMessage {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
}));

// Import after mocks are registered
const { OpenRouterProvider } = await import('./openrouter.provider');

// --- Tests -------------------------------------------------------------

describe('OpenRouterProvider', () => {
  beforeEach(() => {
    capturedCtorArgs = undefined;
    capturedBindArgs = undefined;
    capturedInvokeArgs = undefined;
    fakeInvoke.mockClear();
    fakeBind.mockClear();
  });

  it('configures ChatOpenAI with OpenRouter baseURL and headers', () => {
    new OpenRouterProvider({
      apiKey: 'sk-test-key',
      model: 'anthropic/claude-sonnet-4.5',
    });

    expect(capturedCtorArgs).toMatchObject({
      modelName: 'anthropic/claude-sonnet-4.5',
      openAIApiKey: 'sk-test-key',
      timeout: 60_000,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/fusuyfusuy/x-reporter',
          'X-Title': 'x-reporter',
        },
      },
    });
  });

  it('exposes the model name', () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'openai/gpt-4o',
    });
    expect(provider.model).toBe('openai/gpt-4o');
  });

  it('sends system + user messages and returns content + usage', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'anthropic/claude-sonnet-4.5',
    });

    const opts: ChatOptions = {
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    };

    const result = await provider.chat(opts);

    expect(result.content).toBe('Hello from the LLM');
    expect(result.usage).toEqual({ tokensIn: 42, tokensOut: 17 });

    // Verify messages were built correctly
    const msgs = capturedInvokeArgs as Array<{ content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.content).toBe('You are helpful.');
    expect(msgs[1]?.content).toBe('Hi');
  });

  it('passes responseFormat json as response_format bind param', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    await provider.chat({
      messages: [{ role: 'user', content: 'Return JSON' }],
      responseFormat: 'json',
    });

    expect(capturedBindArgs).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('passes temperature and maxTokens to bind', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.3,
      maxTokens: 1024,
    });

    expect(capturedBindArgs).toMatchObject({
      temperature: 0.3,
      max_tokens: 1024,
    });
  });

  it('handles missing usage gracefully (defaults to 0)', async () => {
    // Override invoke to return no usage metadata
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs flexible typing
    fakeInvoke.mockImplementationOnce(async (): Promise<any> => ({
      content: 'No usage info',
      response_metadata: {},
    }));

    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.usage).toEqual({ tokensIn: 0, tokensOut: 0 });
  });

  it('handles assistant messages in the conversation', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    await provider.chat({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Follow up' },
      ],
    });

    const msgs = capturedInvokeArgs as Array<{ content: string }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.content).toBe('Hello');
    expect(msgs[1]?.content).toBe('Hi there');
    expect(msgs[2]?.content).toBe('Follow up');
  });

  it('falls back to JSON.stringify when content is not a string', async () => {
    const complexContent = [{ type: 'text', text: 'structured response' }];
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs flexible typing
    fakeInvoke.mockImplementationOnce(async (): Promise<any> => ({
      content: complexContent,
      response_metadata: {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    }));

    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.content).toBe(JSON.stringify(complexContent));
    expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 5 });
  });

  it('does not pass response_format for text mode', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'test/model',
    });

    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      responseFormat: 'text',
    });

    expect(capturedBindArgs).toEqual({});
  });
});
