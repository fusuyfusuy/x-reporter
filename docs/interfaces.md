# Swap-points

x-reporter has four deliberate seams. Each is a TypeScript interface with one
default implementation. Adding a new impl should never require changes outside
its own module.

The first three (`XSource`, `ArticleExtractor`, `LlmProvider`) cover the
content pipeline — where data comes *from*, how it's *cleaned*, and who
*reasons* over it. The fourth (`XOAuthClient`) covers the sign-in handshake;
it talks to the same vendor as `XSource` but has a different lifecycle, error
model, and call site, so it lives behind its own port.

## 1. `XSource`

Where it lives: `src/ingestion/x-source.port.ts`
Default impl: `src/ingestion/x-api-v2.source.ts`

```ts
export type TweetKind = 'like' | 'bookmark';

export interface TweetItem {
  tweetId: string;        // X tweet snowflake
  text: string;
  authorHandle: string;   // X handle without leading '@'; '' if unresolved
  urls: string[];         // expanded, t.co-stripped, deduped, sorted
  kind: TweetKind;        // stamped by the adapter so downstream consumers never guess
}

export interface FetchPage {
  items: TweetItem[];
  nextCursor?: string;    // `meta.next_token` from X; absent = end of history
}

export interface XSource {
  /** Fetch at most one page of liked tweets. `userId` is the Appwrite id, not the X numeric id. */
  fetchLikes(userId: string, cursor?: string): Promise<FetchPage>;

  /** Fetch at most one page of bookmarks. `userId` is the Appwrite id, not the X numeric id. */
  fetchBookmarks(userId: string, cursor?: string): Promise<FetchPage>;
}
```

**Shape notes:**
- `tweetId` rather than `id` makes the field unambiguous at call sites
  that juggle multiple kinds of id (userId, tweetId, cursor).
- `kind` is stamped by the adapter so the `poll-x` processor (#7) can
  pass the value straight into `items.kind` without tracking which
  `fetch*` call produced a given item.
- `createdAt` is intentionally absent. The `items` collection stores
  `fetchedAt` (ingest time), not the tweet's original creation time, so
  reading it off the X response would be wasted bytes for v1.
- `items` mirrors the `items` collection name in
  [data-model.md](./data-model.md).

**Default impl notes:**
- Uses X API v2 endpoints `/2/users/:id/liked_tweets` and `/2/users/:id/bookmarks`.
- Resolves the X numeric id via `UsersRepo.findById(userId)`; refuses to
  poll a user whose status is not `active`.
- Reads a fresh bearer token for every call via
  `AuthService.getValidAccessToken(userId)`; `AuthExpiredError`
  propagates untouched so the #7 processor can stop retrying.
- Parses the response with a strict zod schema (`id` and `text` are
  required; everything else is optional/passthrough).
- Pagination via `pagination_token`. The cursor on the way in is the
  `pagination_token` of the next page; `FetchPage.nextCursor` is
  `meta.next_token` from the response, or `undefined` when exhausted.
- Maps `entities.urls[].expanded_url` into `TweetItem.urls` via
  `./url-extractor.ts`, falling back to a text regex when entities are
  absent; `t.co` wrappers are filtered in both branches.
- Wired into NestJS via `IngestionModule` under the `X_SOURCE` string
  token (exported from the same module).

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

## 4. `XOAuthClient`

Where it lives: `src/auth/x-oauth-client.ts`
Default impl: `HttpXOAuthClient` (same file)

```ts
export interface XTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;     // seconds
  scope: string;         // space-separated
}

export interface XUserInfo {
  xUserId: string;       // X numeric user id
  handle: string;        // without leading '@'
}

export interface XOAuthClient {
  /** Build the URL to redirect the user to so they can authorize. */
  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string;
  /** Exchange an authorization code for tokens. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse>;
  /** Refresh an existing access token. */
  refresh(refreshToken: string): Promise<XTokenResponse>;
  /** Resolve the authenticated user identity from a fresh access token. */
  getMe(accessToken: string): Promise<XUserInfo>;
}
```

**Default impl notes:**
- `HttpXOAuthClient` wraps Bun's native `fetch`. The auth module is the only
  consumer; `AuthService` injects the port and never imports `fetch` directly.
- Token endpoint responses are validated with a zod schema before being
  surfaced to `AuthService`, so malformed payloads fail loud at the boundary.
- `getMe` is part of the sign-in handshake — it lives on this port (rather
  than `XSource`) so the auth module never has to import anything from the
  ingestion module.

**Other impls you could swap in:**
- `FakeXOAuthClient` — used in unit tests; deterministic token responses, no
  network. Lives in `src/auth/auth.service.test.ts` (and its sibling tests).

## Why these four seams (and only these)

The first three are the places where the project touches an external system
whose vendor we don't control or whose pricing/performance might force a swap:
- Where data comes *from* (`XSource`)
- How content is *cleaned* (`ArticleExtractor`)
- Who *reasons* over it (`LlmProvider`)

`XOAuthClient` is the fourth seam because the sign-in handshake has a
fundamentally different shape than ongoing data ingestion (it's stateless,
runs once per session, and has its own error model around token refresh and
`auth_expired`). Folding it into `XSource` would conflate two unrelated
lifecycles; keeping it separate also lets tests fake the OAuth dance without
faking the data API.

Everything else (Appwrite, BullMQ, Nest) is a foundation we're committing to.
