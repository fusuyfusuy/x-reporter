import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { ChatOptions, ChatResult, LlmProvider } from './llm-provider.interface';

/**
 * Configuration extracted from `Env` so the adapter never imports the
 * config module directly. The factory in `./index.ts` bridges the two.
 */
export interface OpenRouterConfig {
  apiKey: string;
  model: string;
}

/**
 * Default `LlmProvider` adapter — wraps `@langchain/openai` `ChatOpenAI`
 * pointed at the OpenRouter API.
 *
 * OpenRouter conventions applied:
 *   - `baseURL` → `https://openrouter.ai/api/v1`
 *   - `HTTP-Referer` header so OpenRouter can attribute traffic
 *   - `X-Title` header for the OpenRouter dashboard
 *
 * Token accounting is read from the LangChain response metadata
 * (`response_metadata.usage`), which OpenRouter populates in the
 * standard OpenAI shape.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly model: string;
  private readonly client: ChatOpenAI;

  constructor(config: OpenRouterConfig) {
    this.model = config.model;
    this.client = new ChatOpenAI({
      modelName: config.model,
      openAIApiKey: config.apiKey,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/fusuyfusuy/x-reporter',
          'X-Title': 'x-reporter',
        },
      },
    });
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const messages = this.buildMessages(opts);

    const bound = this.client.bind({
      ...(opts.responseFormat === 'json'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });

    const response = await bound.invoke(messages);

    const content =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    // LangChain populates `response_metadata.usage` from the OpenAI-compatible
    // response body. OpenRouter follows the same shape.
    const usage = (response.response_metadata?.usage ?? {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
    };

    return {
      content,
      usage: {
        tokensIn: usage.prompt_tokens ?? 0,
        tokensOut: usage.completion_tokens ?? 0,
      },
    };
  }

  private buildMessages(opts: ChatOptions) {
    const msgs: (SystemMessage | HumanMessage | AIMessage)[] = [];

    if (opts.system) {
      msgs.push(new SystemMessage(opts.system));
    }

    for (const m of opts.messages) {
      if (m.role === 'user') {
        msgs.push(new HumanMessage(m.content));
      } else {
        msgs.push(new AIMessage(m.content));
      }
    }

    return msgs;
  }
}
