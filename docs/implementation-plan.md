# Implementation plan

Each milestone below corresponds to one GitHub issue. Issues are intended to
be tackled in order — later milestones assume earlier ones are merged.

## 1. chore: scaffold Bun + NestJS project
Lay down the project skeleton.

**Acceptance criteria**
- `bun init` complete; `package.json` configured for Bun + Nest.
- NestJS installed with `@nestjs/platform-express`.
- `src/main.ts` boots a Nest app on `PORT`.
- `src/config/env.ts` validates env via zod, fails fast on bad config.
- `src/common/logger.ts` wires `nestjs-pino`.
- `GET /health` returns `{ status: 'ok' }` (subsystem checks added in later issues).
- `bun test` runs and passes a placeholder test.
- `tsconfig.json`, `.gitignore`, `.env.example` committed.

Doc refs: [architecture.md](./architecture.md), [configuration.md](./configuration.md)

---

## 2. feat(appwrite): SDK wrapper + collection bootstrap
Persistence foundation.

**Acceptance criteria**
- `AppwriteModule` + `AppwriteService` wrap `node-appwrite` with typed helpers.
- `scripts/setup-appwrite.ts` is **idempotent** and creates the database, all
  collections, attributes, and indexes from [data-model.md](./data-model.md).
- Re-running the script after a clean run is a no-op (no errors, no duplicate indexes).
- `/health` now also pings Appwrite.

Doc refs: [data-model.md](./data-model.md)

---

## 3. feat(auth): X OAuth2 PKCE flow
Sign-in.

**Acceptance criteria**
- `GET /auth/x/start` generates `state` + `code_verifier`, stores them in a signed short-lived cookie, redirects to X authorize URL.
- `GET /auth/x/callback` validates `state`, exchanges `code` for tokens, encrypts with AES-256-GCM, persists to `tokens`.
- `users` row upserted on first sign-in.
- Session cookie issued on success; 302 to `/me`.
- `AuthService.getValidAccessToken(userId)` refreshes the token transparently if expired.
- Refresh failure marks `user.status = 'auth_expired'`.
- Unit tests for `crypto.ts` (encrypt/decrypt round-trip) and PKCE generation.

Doc refs: [api.md](./api.md#auth), [configuration.md](./configuration.md#token-encryption-at-rest)

---

## 4. feat(users): /me endpoints + cadence settings
Cadence is user-controlled.

**Acceptance criteria**
- `GET /me` returns the authenticated user's profile + cadence.
- `PATCH /me` accepts `pollIntervalMin` (>=5) and `digestIntervalMin` (>=15), validates with zod, persists.
- After PATCH, `ScheduleService.upsertJobsForUser` is called (stub OK; real call hooked in issue #5).
- Returns `401` without a session cookie.
- E2E test: sign in stub → GET → PATCH → GET reflects changes.

Doc refs: [api.md](./api.md#me)

---

## 5. feat(queue): BullMQ infra + ScheduleService
Queue plumbing and repeatable-job sync.

**Acceptance criteria**
- `QueueModule` exposes BullMQ `Queue` instances for `poll-x`, `extract-item`, `build-digest`.
- Connection configured from `REDIS_URL`.
- `ScheduleService.upsertJobsForUser(userId)` is idempotent: registers `user:{id}:poll` and `user:{id}:digest` repeatable jobs at the user's intervals; replaces existing entries on cadence change; removes both on user delete / `auth_expired`.
- Wired into `AuthModule` (post-callback) and `UsersModule` (post-PATCH).
- `/health` now also pings Redis.

Doc refs: [jobs.md](./jobs.md#repeatable-jobs)

---

## 6. feat(ingestion): XSource interface + X API v2 impl
Data input seam.

**Acceptance criteria**
- `XSource` interface defined per [interfaces.md](./interfaces.md#1-xsource).
- `XApiV2Source` implements `fetchLikes` and `fetchBookmarks` against X API v2 using `AuthService` for tokens.
- `url-extractor.ts` pulls expanded URLs from `entities.urls` and falls back to text regex; t.co stripped to canonical.
- Cursor handling: returns `nextCursor` for downstream callers.
- Unit tests for `url-extractor` covering: pure-text URLs, multiple URLs, `entities.urls` precedence, dedup.
- No processor wiring yet (issue #7).

Doc refs: [interfaces.md](./interfaces.md#1-xsource)

---

## 7. feat(workers): poll-x processor
Periodic ingestion.

**Acceptance criteria**
- `WorkersModule` exists with `PollXProcessor` consuming the `poll-x` queue.
- Processor: refreshes tokens, calls `XSource`, upserts `items` (deduped on `xTweetId`), updates user cursors, enqueues `extract-item` for items with non-empty `urls`.
- Retries per [jobs.md](./jobs.md#retry-policy).
- Logs `userId, attempt, durationMs, newItems`.
- E2E test using a stub `XSource` injected via the Nest test module.

Doc refs: [jobs.md](./jobs.md#pollxprocessor)

---

## 8. feat(extraction): ArticleExtractor interface + Firecrawl impl
Content cleaning seam + worker.

**Acceptance criteria**
- `ArticleExtractor` interface defined per [interfaces.md](./interfaces.md#2-articleextractor).
- `FirecrawlExtractor` calls Firecrawl `/v1/scrape` (markdown format), maps to `ExtractedArticle`, sets `extractor: 'firecrawl'`.
- `ExtractItemProcessor` loads the item, extracts each URL, persists `articles`, marks `item.enriched = true`.
- Per-URL failures logged but only fail the job if *all* URLs fail.
- Unit test with mocked Firecrawl HTTP.

Doc refs: [interfaces.md](./interfaces.md#2-articleextractor), [jobs.md](./jobs.md#extractitemprocessor)

---

## 9. feat(digest): LlmProvider interface + OpenRouter impl
LLM seam.

**Acceptance criteria**
- `LlmProvider` interface defined per [interfaces.md](./interfaces.md#3-llmprovider).
- `OpenRouterProvider` wraps `@langchain/openai` `ChatOpenAI` with OpenRouter `baseURL`.
- Sends `HTTP-Referer` and `X-Title` headers per OpenRouter conventions.
- Returns `{ content, usage }` with token counts populated from the OpenRouter response.
- `createLlmProvider(env)` factory in `src/digest/llm/index.ts`; Nest custom provider exposes `LlmProvider` for injection.
- Unit test using a mocked HTTP client.

Doc refs: [interfaces.md](./interfaces.md#3-llmprovider)

---

## 10. feat(digest): LangGraph DigestGraph
The brain.

**Acceptance criteria**
- `digest.graph.ts` builds a LangGraph `StateGraph<DigestState>` with nodes `cluster`, `summarize`, `rank`, `compose`.
- `summarize` fans out per cluster via `Send`.
- Each node uses the injected `LlmProvider`; prompts live as constants in each node module.
- Graph accumulates token usage into `state.usage`.
- Unit tests run the full graph with a `StubLlmProvider` returning fixed JSON; assert final `state.markdown` and `state.usage`.

Doc refs: [llm-and-graph.md](./llm-and-graph.md)

---

## 11. feat(workers): build-digest processor + /digests endpoints
Putting it together.

**Acceptance criteria**
- `BuildDigestProcessor` resolves the time window, loads enriched items + articles, runs `DigestGraph`, persists a `digests` row including `markdown`, `itemIds`, `model`, `tokensIn`, `tokensOut`.
- No-op (no row written) when there are zero enriched items in window.
- `GET /digests` paginated list (newest first) with `preview` field.
- `GET /digests/:id` returns the full digest; 404 if not owned by caller.
- `POST /digests/run-now` enqueues a one-shot `build-digest` job and returns `202` with `jobId`.

Doc refs: [api.md](./api.md#digests), [jobs.md](./jobs.md#builddigestprocessor)

---

## 12. test: e2e smoke + URL extraction unit tests
Coverage pass.

**Acceptance criteria**
- E2E suite covers `/health`, `/me` (GET + PATCH), `/digests` (GET list, GET id, POST run-now), using stub `XSource`, stub `ArticleExtractor`, stub `LlmProvider`.
- Unit suite covers `url-extractor` edge cases and `DigestGraph` end-to-end with stubs.
- `bun test` is green in CI (CI config out of scope; just must pass locally).

Doc refs: [configuration.md](./configuration.md#tests)

---

## 13. chore: docker-compose + README run steps
Make it runnable for a new contributor.

**Acceptance criteria**
- `docker-compose.yml` brings up Redis and Appwrite.
- Top-level `README.md` has a quickstart that mirrors [configuration.md](./configuration.md#local-dev-quickstart) and links into `docs/`.
- `.env.example` is complete and matches `src/config/env.ts`.

Doc refs: [configuration.md](./configuration.md#local-dev-quickstart)
