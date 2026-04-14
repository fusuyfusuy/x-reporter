/**
 * Reusable `LlmProvider` stub for DigestGraph tests.
 *
 * Each chat() call is matched against the registered handlers in
 * registration order. The first handler whose `match` predicate returns
 * true wins; its `respond` function produces the content. Usage is
 * either the constant `usage` passed to the stub or the per-handler
 * override. Every call is recorded in `.calls` so tests can assert the
 * exact shape of the fanout.
 *
 * This lives alongside the graph (rather than under `test/`) so future
 * issues (snapshot tests, integration tests) can reuse it.
 */
import type {
  ChatOptions,
  ChatResult,
  LlmProvider,
} from '../llm/llm-provider.interface';

export interface StubHandler {
  match: (opts: ChatOptions) => boolean;
  respond: (opts: ChatOptions) => string;
  usage?: { tokensIn: number; tokensOut: number };
}

export interface StubLlmProviderOptions {
  model?: string;
  defaultUsage?: { tokensIn: number; tokensOut: number };
  handlers: StubHandler[];
}

export class StubLlmProvider implements LlmProvider {
  readonly model: string;
  readonly calls: ChatOptions[] = [];
  private readonly handlers: StubHandler[];
  private readonly defaultUsage: { tokensIn: number; tokensOut: number };

  constructor(opts: StubLlmProviderOptions) {
    this.model = opts.model ?? 'stub-model';
    this.handlers = opts.handlers;
    this.defaultUsage = opts.defaultUsage ?? { tokensIn: 10, tokensOut: 20 };
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.calls.push(opts);
    const handler = this.handlers.find((h) => h.match(opts));
    if (!handler) {
      const preview = opts.messages[0]?.content?.slice(0, 120) ?? '(no message)';
      throw new Error(`StubLlmProvider: no handler matched. First message: ${preview}`);
    }
    return {
      content: handler.respond(opts),
      usage: handler.usage ?? this.defaultUsage,
    };
  }
}
