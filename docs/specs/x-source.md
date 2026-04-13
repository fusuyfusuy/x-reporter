---
title: "XSource ingestion port + X API v2 impl"
type: spec
tags: [ingestion, xsource, x-api, tweets, likes, bookmarks, url-extractor, zod, ports, adapters]
created: 2026-04-07
updated: 2026-04-07
issue: 6
---

## Behavior

This milestone introduces the first ingestion seam: a typed `XSource` port
that describes "fetch a page of liked or bookmarked tweets for a user", and
its default implementation against X API v2. Downstream (milestone #7) a
BullMQ `poll-x` processor will inject `XSource` by token and persist the
results into the `items` collection; no persistence happens in this
milestone.

It introduces:

1. **`IngestionModule`** (`src/ingestion/ingestion.module.ts`) wired into
   `AppModule`. Registers `XApiV2Source` under the `X_SOURCE` DI token and
   re-exports it so the poll-x processor in #7 can inject `XSource` without
   importing the adapter directly. Imports `AuthModule` for access to
   `AuthService.getValidAccessToken`.

2. **`XSource` port** (`src/ingestion/x-source.port.ts`) — the only thing
   the rest of the system knows about for reading tweets. Shape:

   ```ts
   export type TweetKind = 'like' | 'bookmark';

   export interface TweetItem {
     tweetId: string;        // X tweet snowflake
     text: string;           // raw tweet text
     authorHandle: string;   // X handle without leading '@', '' if unresolved
     urls: string[];         // expanded, deduped, t.co-stripped, sorted
     kind: TweetKind;        // 'like' when returned by fetchLikes, 'bookmark' by fetchBookmarks
   }

   export interface FetchPage {
     items: TweetItem[];
     nextCursor?: string;    // pagination_token for the next call; absent = end of pages
   }

   export interface XSource {
     fetchLikes(userId: string, cursor?: string): Promise<FetchPage>;
     fetchBookmarks(userId: string, cursor?: string): Promise<FetchPage>;
   }
   ```

   `userId` is the internal Appwrite document id (`users.$id`), NOT the
   X numeric user id — it is what `AuthService.getValidAccessToken`
   consumes. The adapter is responsible for resolving the X user id
   separately (see below).

3. **`XApiV2Source`** (`src/ingestion/x-api-v2.source.ts`) — the default
   adapter. For each `fetch*` call:
   1. Call `UsersRepo.findById(userId)` to resolve `xUserId` (the X numeric
      id needed in the path) and the user's current status. If no row, or
      status is not `active`, throw.
   2. Call `AuthService.getValidAccessToken(userId)` to get a fresh bearer
      token. Any `AuthExpiredError` bubbles up unchanged so the caller
      (BullMQ processor in #7) can stop retrying.
   3. `GET https://api.twitter.com/2/users/:xUserId/liked_tweets` (or
      `/bookmarks`) with query params
      `expansions=author_id`,
      `tweet.fields=entities,author_id,text`, `user.fields=username`,
      `max_results=100`, and `pagination_token=<cursor>` when `cursor` is
      present. Header `Authorization: Bearer <accessToken>`. The
      `expansions=author_id` is what causes X to populate
      `includes.users` — without it, `user.fields` is silently ignored
      and `authorHandle` would always fall back to `''`.
   4. Abort the request after a configurable timeout
      (`DEFAULT_FETCH_TIMEOUT_MS = 10_000`).
   5. On non-2xx, throw an `Error` whose message includes the status and a
      truncated body (token never appears in the message).
   6. Parse the JSON response with a strict zod schema and map each tweet
      through `extractUrls` to fill `urls[]`, resolving `authorHandle` from
      `includes.users[n].username` keyed by `author_id`.
   7. Return `{ items, nextCursor: meta.next_token }`. `nextCursor` is
      undefined when the response has no more pages.

4. **`url-extractor`** (`src/ingestion/url-extractor.ts`) — a pure,
   framework-free function with signature:

   ```ts
   interface EntityUrl { expanded_url?: string; url?: string }
   interface TweetForExtraction { text: string; entities?: { urls?: EntityUrl[] } }
   export function extractUrls(tweet: TweetForExtraction): string[];
   ```

   Logic:
   - **Source selection**: if `entities.urls` is present and non-empty, use
     `expanded_url` from each entry (skipping entries without one); if any
     `expanded_url` is missing, fall back to the entry's `url` field. Do
     NOT also regex-scan the text in this branch — X already did the work.
   - **Fallback**: if `entities.urls` is missing or empty, regex-scan
     `tweet.text` for `https?://...` URLs.
   - **t.co stripping**: filter out any URL whose hostname is `t.co`. This
     catches both the wrapped-short-url form and the case where `entities`
     only contains the short form (no `expanded_url`).
   - **Normalize + dedup**: lowercase for dedup comparison, keep the first
     spelling encountered, sort alphabetically by the lowercased value for
     determinism.

## Constraints

- **Hexagonal boundary.** `fetch` against `api.twitter.com` happens only
  inside `src/ingestion/`. The `XSource` port does not mention `fetch`,
  `Response`, Bun types, or any X-specific request/response shape.
- **Zod at the boundary.** The X API v2 response is parsed with a strict
  zod schema. Extra fields are allowed; the fields the adapter depends on
  (`data[].id`, `data[].text`) are required. Zod parse failures are
  rethrown with a descriptive message so the #7 BullMQ processor retries.
- **Auth delegation.** The adapter never touches the `tokens` collection
  directly. It calls `AuthService.getValidAccessToken(userId)` for a fresh
  plaintext bearer token every call. `AuthExpiredError` propagates.
- **No persistence.** This milestone produces in-memory `TweetItem[]`
  only. Writing to Appwrite is #7.
- **No rate limiting, no retry at the HTTP level.** BullMQ's retry
  policy in #7 handles transient failures; this adapter's job is to map
  X's response into the port type or throw.
- **No media / poll expansion.** Only `text` and `entities.urls` are
  consumed. Media, polls, quoted-tweet expansion, and reply-context are
  out of scope for v1.
- **Logging hygiene.** Tokens, refresh tokens, and raw `Authorization`
  headers never appear in log output or thrown error messages.
- **Pure `url-extractor`.** No NestJS decorators, no module imports other
  than pure language features; testable without any DI container.

## Acceptance Criteria

- [ ] `XSource` interface defined at `src/ingestion/x-source.port.ts` with
  the `TweetItem`, `FetchPage`, and `XSource` shapes above.
- [ ] `XApiV2Source` implements `fetchLikes(userId, cursor?)` and
  `fetchBookmarks(userId, cursor?)` against X API v2 using
  `AuthService.getValidAccessToken` for the bearer token and `UsersRepo`
  for the X numeric user id.
- [ ] Cursor pass-through: when `cursor` is provided it becomes
  `pagination_token` on the outbound request; when `meta.next_token` is
  present on the response it becomes `nextCursor` on the return value;
  when absent, `nextCursor` is `undefined`.
- [ ] `url-extractor.ts` exports `extractUrls` which returns expanded URLs
  from `entities.urls` when present, falls back to a text regex otherwise,
  strips `t.co` wrappers in both branches, dedupes case-insensitively,
  and sorts alphabetically.
- [ ] `IngestionModule` registers `XApiV2Source` under the `X_SOURCE` DI
  token, exports the token, and imports `AuthModule` so `AuthService` is
  injectable.
- [ ] `AppModule.forRoot` imports `IngestionModule`.
- [ ] Unit tests cover `url-extractor`: no URLs; pure-text URLs; multiple
  URLs; `entities.urls` precedence over text; dedup (case-insensitive);
  `t.co` filtering from both text and `entities.urls`.
- [ ] Unit tests cover `XApiV2Source` with a fake `fetch` + fake
  `AuthService` + fake `UsersRepo`: happy-path fetchLikes, happy-path
  fetchBookmarks, cursor round-trip, pagination (response with
  `meta.next_token`), `AuthExpiredError` propagation, HTTP non-2xx throws
  with truncated body, malformed response surfaces as a zod parse error.
- [ ] `bun test`, `bunx tsc --noEmit`, `bunx biome lint .` are green.
- [ ] `package.json` version bumped `0.4.0 → 0.5.0`.
- [ ] `docs/interfaces.md` §1 updated to reflect the refined `TweetItem`
  shape (renamed from `RawTweet`, added `kind`, dropped `createdAt`) so
  the spec tier stays authoritative.

## Out of scope (deferred)

- Writing items to Appwrite (#7).
- BullMQ `poll-x` processor wiring (#7).
- HTTP-level retry / rate-limit handling (BullMQ covers this in #7).
- Tweet media, polls, quote-tweet / reply-context expansion.
- Bookmark write-back (deleting a bookmark after ingest).
- `XBrowserSource` / `XMockSource` alternative impls — left as future work
  per `docs/interfaces.md` §1.
