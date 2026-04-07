# Architecture

## Overview

x-reporter is a NestJS service running on Bun. It exposes a small REST API,
persists state in Appwrite, and runs all background work through BullMQ
workers backed by Redis. AI orchestration happens inside a LangGraph state
machine that calls a pluggable `LlmProvider`.

```
                ┌──────────────────────────────────────────┐
                │            NestJS (Bun)                  │
                │                                          │
  X OAuth ──►   │  AuthModule  ──► Appwrite (users,tokens) │
                │                                          │
                │  UsersModule (cadence, prefs)            │
                │                                          │
                │  IngestionModule                         │
                │   └─ XSource (interface)                 │
                │        └─ XApiV2Source (impl)            │
                │                                          │
                │  ExtractionModule                        │
                │   └─ ArticleExtractor (interface)        │
                │        └─ FirecrawlExtractor (impl)      │
                │                                          │
                │  DigestModule                            │
                │   └─ LlmProvider (interface)             │
                │        └─ OpenRouterProvider (impl)      │
                │   └─ LangGraph: DigestGraph              │
                │                                          │
                │  QueueModule    (BullMQ + Redis client)  │
                │  ScheduleModule (per-user repeatables)   │
                │  WorkersModule  (BullMQ consumers)       │
                │                                          │
                │  REST: /me, /digests, /auth/x, /health   │
                └──────────────────────────────────────────┘
                          │                  │
                          ▼                  ▼
                       Redis             Appwrite
```

## Modules

| Module              | Responsibility                                                                |
|---------------------|-------------------------------------------------------------------------------|
| `AppwriteModule`    | Thin SDK wrapper. All other modules depend on it for persistence.             |
| `UsersRepoModule`   | Global module exposing `UsersRepo` (the leaf adapter over Appwrite for the `users` collection). Lifted out of AuthModule in #5 so `ScheduleService` can read cadence without depending on AuthModule. |
| `AuthModule`        | X OAuth2 PKCE flow, encrypted token storage, session cookie issuance.         |
| `UsersModule`       | `/me` endpoints. Owns cadence settings (`pollIntervalMin`, `digestIntervalMin`). |
| `IngestionModule`   | `XSource` interface + default X API v2 impl. URL extraction from tweets.     |
| `ExtractionModule`  | `ArticleExtractor` interface + default Firecrawl impl.                       |
| `DigestModule`      | `LlmProvider` interface + OpenRouter impl. LangGraph `DigestGraph`. REST.    |
| `QueueModule`       | BullMQ connection, queue tokens for `poll-x` / `extract-item` / `build-digest`, shared ioredis client, Redis health helper. Owns the BullMQ + ioredis lifecycle (`onModuleDestroy` drains queues + quits client). |
| `ScheduleModule`    | `ScheduleService` — the seam between cadence changes and BullMQ repeatable jobs. Public surface is `(userId) => Promise<void>` so consumers (`AuthService`, `UsersService`) never see BullMQ types. |
| `WorkersModule`     | BullMQ processors: `poll-x`, `extract-item`, `build-digest`. (Arrives in #7 / #8 / #11.) |

## Data flow

### 1. Onboarding
1. User hits `GET /auth/x/start` → redirect to X OAuth2 authorize URL with PKCE.
2. X redirects back to `GET /auth/x/callback` with `code`.
3. `AuthService` exchanges code for tokens, encrypts them with AES-256-GCM, persists to Appwrite `tokens` collection. Creates the `users` row if missing.
4. Session cookie issued. `ScheduleService.upsertJobsForUser(userId)` registers the user's repeatable BullMQ jobs.

### 2. Polling (per user, every `pollIntervalMin`)
1. `poll-x` worker loads the user's tokens, refreshes if expired.
2. Calls `XSource.fetchLikes(cursor)` and `XSource.fetchBookmarks(cursor)`.
3. Persists new `items` (deduped on `xTweetId`).
4. For each item containing URLs, enqueues an `extract-item` job.
5. Updates `lastLikeCursor` / `lastBookmarkCursor` on the user.

### 3. Extraction (per item)
1. `extract-item` worker calls `ArticleExtractor.extract(url)` for each URL on the item.
2. Persists `articles` rows linked to the item.
3. Marks `item.enriched = true`.

### 4. Digest build (per user, every `digestIntervalMin`)
1. `build-digest` worker loads enriched items in `[now - digestIntervalMin, now]`.
2. Runs `DigestGraph` (see [llm-and-graph.md](./llm-and-graph.md)).
3. Persists a `digests` row containing the markdown body, source `itemIds`, and token usage.

### 5. Read
- `GET /digests` and `GET /digests/:id` serve persisted digests directly from Appwrite. No background work triggered.

## Failure model

- Every external call (X API, Firecrawl, OpenRouter) lives inside a BullMQ job.
- Jobs use exponential backoff with a max attempts cap (see [jobs.md](./jobs.md)).
- The HTTP layer never makes a third-party call on the request path except for `POST /digests/run-now`, which only enqueues a job.
- Token refresh failures mark the user `auth_expired` and stop scheduling new polls until reauth.

## Concurrency & scaling

- Workers are horizontally scalable. BullMQ guarantees a job runs on at most one worker.
- Repeatable jobs use the BullMQ 5.x Job Scheduler API with stable scheduler ids
  (`user:{id}:poll`, `user:{id}:digest`), so re-registering with a new cadence
  REPLACES the existing entry rather than producing a duplicate. See
  [jobs.md](./jobs.md#repeatable-jobs) for the full contract.
- Appwrite is the only stateful store besides Redis. The Nest process is stateless and can be replicated.

## What's deliberately *not* in v1

- Email / web UI / RSS delivery
- Embedding-based dedup across digests
- Tweet thread reconstruction
- Multi-language digests
- Billing / quotas
