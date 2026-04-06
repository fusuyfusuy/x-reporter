# Swap-points

x-reporter has three deliberate seams. Each is a TypeScript interface with one
default implementation. Adding a new impl should never require changes outside
its own module.

## 1. `XSource`

Where it lives: `src/ingestion/x-source.interface.ts`
Default impl: `src/ingestion/x-api-v2.source.ts`

```ts
export interface RawTweet {
  id: string;            // X tweet snowflake
  text: string;
  authorHandle: string;
  urls: string[];        // expanded URLs
  createdAt: string;     // ISO
}

export interface FetchPage {
  tweets: RawTweet[];
  nextCursor?: string;
}

export interface XSource {
  /** Fetch new likes since `cursor`. Returns at most one page. */
  fetchLikes(userId: string, cursor?: string): Promise<FetchPage>;

  /** Fetch new bookmarks since `cursor`. Returns at most one page. */
  fetchBookmarks(userId: string, cursor?: string): Promise<FetchPage>;
}
```

**Default impl notes:**
- Uses X API v2 endpoints `/2/users/:id/liked_tweets` and `/2/users/:id/bookmarks`.
- Reads OAuth2 tokens from `tokens` collection via `AuthService`.
- Refreshes the access token if expired before each call.
- Pagination via `pagination_token`. Cursor is the most recent `pagination_token` we've consumed.
- Maps `entities.urls[].expanded_url` into `RawTweet.urls`.

**Other impls you could swap in:**
- `XBrowserSource` — headless browser using stored cookies. No API costs.
- `XMockSource` — fixture-driven, used in tests.

## 2. `ArticleExtractor`

Where it lives: `src/extraction/article-extractor.interface.ts`
Default impl: `src/extraction/firecrawl.extractor.ts`

```ts
export interface ExtractedArticle {
  url: string;            // input
  canonicalUrl?: string;
  title?: string;
  byline?: string;
  siteName?: string;
  content: string;        // markdown
  extractor: string;      // identifier (e.g. 'firecrawl')
}

export interface ArticleExtractor {
  extract(url: string): Promise<ExtractedArticle>;
}
```

**Default impl notes:**
- Calls Firecrawl `/v1/scrape` with `formats: ['markdown']`.
- Sets `extractor: 'firecrawl'` on every result.
- Throws on non-2xx so BullMQ retries.
- Per-URL char cap: 50k. Larger articles are truncated with a `…` marker.

**Other impls:**
- `ReadabilityExtractor` — `@mozilla/readability` + `jsdom` over `undici`.
- `DiffbotExtractor`, `MercuryExtractor` — alternative third-party APIs.

## 3. `LlmProvider`

Where it lives: `src/digest/llm/llm-provider.interface.ts`
Default impl: `src/digest/llm/openrouter.provider.ts`

```ts
export interface LlmProvider {
  readonly model: string;

  chat(opts: {
    system?: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    responseFormat?: 'text' | 'json';
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    usage: { tokensIn: number; tokensOut: number };
  }>;
}
```

**Default impl notes:**
- Wraps `@langchain/openai` `ChatOpenAI` configured with
  `configuration.baseURL = 'https://openrouter.ai/api/v1'` and
  `apiKey = OPENROUTER_API_KEY`.
- `model` comes from `OPENROUTER_MODEL` env (e.g. `anthropic/claude-sonnet-4.5`).
- Sets the `HTTP-Referer` and `X-Title` headers OpenRouter recommends.

**Other impls:**
- `AnthropicProvider` — direct `@langchain/anthropic`.
- `OpenAIProvider` — direct OpenAI.
- `OllamaProvider` — local models.
- `StubLlmProvider` — used in unit tests for the digest graph.

## Provider factory

`src/digest/llm/index.ts` exports a factory:

```ts
export function createLlmProvider(env: Env): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case 'openrouter': return new OpenRouterProvider(env);
    // case 'anthropic': return new AnthropicProvider(env);
    default: throw new Error(`Unknown LLM_PROVIDER: ${env.LLM_PROVIDER}`);
  }
}
```

NestJS wires this through a custom provider so the rest of the app injects
`LlmProvider` directly without knowing which impl is in play.

## Why these three seams (and only these)

These are the three places where the project touches an external system whose
vendor we don't control or whose pricing/performance might force a swap:
- Where data comes *from* (`XSource`)
- How content is *cleaned* (`ArticleExtractor`)
- Who *reasons* over it (`LlmProvider`)

Everything else (Appwrite, BullMQ, Nest) is a foundation we're committing to.
