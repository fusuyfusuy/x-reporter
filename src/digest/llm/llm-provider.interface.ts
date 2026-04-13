/**
 * Port interface for LLM interactions.
 *
 * Framework-agnostic: no NestJS, LangChain, or vendor types leak through
 * this boundary. Adapters live behind the interface and are selected at
 * boot by the factory in `./index.ts`.
 *
 * See `docs/interfaces.md` section 3 for the full swap-point contract.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  system?: string;
  messages: ChatMessage[];
  responseFormat?: 'text' | 'json';
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  usage: { tokensIn: number; tokensOut: number };
}

export interface LlmProvider {
  readonly model: string;
  chat(opts: ChatOptions): Promise<ChatResult>;
}
