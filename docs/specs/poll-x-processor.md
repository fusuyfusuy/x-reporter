---
title: "poll-x processor + WorkersModule"
type: spec
tags: [workers, poll-x, bullmq, ingestion, items, cursor, queue, hexagonal]
created: 2026-04-13
updated: 2026-04-13
issue: 7
---

## Behavior

This milestone adds the first BullMQ worker to the system. A new
`WorkersModule` creates a `Worker` instance that consumes the `poll-x`
queue. The processing logic lives in `PollXProcessor`, a plain
injectable class whose public surface carries no BullMQ types.

A new `ItemsRepo` adapter handles persistence for the `items` Appwrite
collection, and `UsersRepo` gains an `updateCursors` method for
persisting pagination state after a successful poll.

Scope:

1. **`PollXProcessor`** (`src/workers/poll-x.processor.ts`) — the
   processing logic for the `poll-x` queue. Injectable class with a
   single public method:

   ```ts
   async process(job: { data: { userId: string }; attemptsMade: number }): Promise<void>
   ```

   Steps:
   a. Load user via `UsersRepo.findById(userId)`. If missing or
      `status !== 'active'`, log at warn and return (no retry — the
      user was deleted or paused between scheduling and execution).
   b. Fetch likes: call `XSource.fetchLikes(userId, user.lastLikeCursor)`,
      follow `nextCursor` until exhausted. Collect all `TweetItem[]`.
   c. Fetch bookmarks: call `XSource.fetchBookmarks(userId, user.lastBookmarkCursor)`,
      follow `nextCursor` until exhausted. Collect all `TweetItem[]`.
   d. Upsert all collected items via `ItemsRepo.upsertMany(userId, items)`.
      Dedup on `(userId, xTweetId)` using `ID.unique()` document IDs with
      a compound unique index; 409 conflicts indicate duplicates.
      Returns `{ id: string; isNew: boolean }[]` so the processor knows
      which items are newly created.
   e. Enqueue `extract-item` jobs: for each new item with non-empty
      `urls[]`, add a job to `EXTRACT_ITEM_QUEUE` with payload
      `{ userId, itemId }`.
   f. Update cursors: call `UsersRepo.updateCursors(userId, { lastLikeCursor, lastBookmarkCursor })`
      with the final cursor from each pagination run. Only called after
      items are persisted — cursors advance only on successful upsert.
   g. Log completion: `userId`, `attempt`, `durationMs`, `newLikes`,
      `newBookmarks`, `newItems`, `extractJobsEnqueued`.

   Error handling:
   - **Auth failure**: if `XSource` throws `AuthExpiredError` (exported
     from `src/auth/auth.service.ts`), catch it and return without
     retrying. `AuthService.getValidAccessToken` — called internally
     by `XApiV2Source` — already calls `failAuth(userId)` before
     throwing, which marks the user `auth_expired` and removes their
     schedulers. The processor does not need to call `failAuth` itself.
   - **Transport errors** (X API timeouts, 5xx): let throw. BullMQ
     retries with the configured backoff.
   - **Appwrite errors** (item upsert, cursor update): let throw.
     BullMQ retries handle transient Appwrite outages.

2. **`ItemsRepo`** (`src/workers/items.repo.ts`) — adapter for the
   `items` Appwrite collection. Follows the same patterns as `TokensRepo`
   and `UsersRepo`: structural typing for the Appwrite SDK, plain shapes
   returned, `null` on 404.

   ```ts
   interface ItemRecord {
     id: string;
     userId: string;
     xTweetId: string;
     kind: TweetKind;
     text: string;
     authorHandle: string;
     urls: string[];
     fetchedAt: string;
     enriched: boolean;
   }
   ```

   Public methods:

   ```ts
   async upsertMany(userId: string, items: TweetItem[]): Promise<{ id: string; isNew: boolean }[]>
   ```
   - Document ID: `ID.unique()` with a compound unique index on
     `(userId, xTweetId)`. On 409 conflict (or `document_already_exists`
     type), query back the existing document and mark `isNew: false`.
   - For each item: try create; on 409 conflict, mark `isNew: false`.
   - Sets `fetchedAt` to current ISO timestamp on create.
   - Sets `enriched` to `false` on create.

   ```ts
   async findByUserAndTweetId(userId: string, xTweetId: string): Promise<ItemRecord | null>
   ```

3. **`UsersRepo.updateCursors`** (`src/users/users.repo.ts`) — new
   method on the existing repo:

   ```ts
   async updateCursors(userId: string, cursors: {
     lastLikeCursor?: string;
     lastBookmarkCursor?: string;
   }): Promise<UserRecord>
   ```
   - Updates only the provided cursor fields (partial patch).
   - Throws if user not found (cursor update on a missing user is a
     bug, unlike `ScheduleService` where a missing user is a no-op).

4. **`WorkersModule`** (`src/workers/workers.module.ts`) — owns the
   BullMQ `Worker` lifecycle.

   ```ts
   static forRoot(env: Env): DynamicModule
   ```

   - Creates `ItemsRepo` provider (injecting `AppwriteService` and
     the items collection ID from env/constants).
   - Creates `PollXProcessor` provider (injecting `X_SOURCE`,
     `EXTRACT_ITEM_QUEUE`, `UsersRepo`, `ItemsRepo`, `AuthService`).
   - In `onModuleInit`: creates a BullMQ `Worker` on queue name
     `'poll-x'`, wired to `PollXProcessor.process`. Configuration:
     - `connection`: shared `REDIS_CLIENT`
     - `concurrency`: `env.POLL_X_CONCURRENCY` (default 5)
   - In `onModuleDestroy`: calls `worker.close()` for graceful
     shutdown (waits for in-flight jobs to finish).
   - Retry/backoff configured via job options on `queue.add()` or
     Queue `defaultJobOptions`. `poll-x` Worker: 5 attempts, exponential
     backoff base 30s, max 10m (per `docs/jobs.md`).

   Registered in `AppModule.forRoot()` after `IngestionModule`:
   ```ts
   imports: [
     // ... existing modules ...
     IngestionModule.forRoot(env),
     WorkersModule.forRoot(env),  // NEW
   ]
   ```

5. **`AuthService` integration** — the processor catches
   `AuthExpiredError` thrown by `XSource` (which internally calls
   `AuthService.getValidAccessToken`). `getValidAccessToken` already
   calls `failAuth` before throwing, so by the time the processor
   sees the error the user is already marked `auth_expired` and their
   schedulers are removed. The processor just catches and returns
   (no retry). No changes to `AuthService` are needed.

## Constraints

- **Hexagonal containment**: BullMQ `Worker` and `Job` types stay
  inside `src/workers/workers.module.ts`. `PollXProcessor`'s public
  method signature uses a plain object type for the job argument, not
  `Job<PollXJob>`.
- **Cursor update ordering**: cursors advance only AFTER items are
  successfully persisted. If item upsert fails and the job retries,
  the same items will be fetched again (idempotent via dedup) rather
  than being silently skipped.
- **No pagination limit on first poll**: a new user's first poll may
  fetch many pages. This is acceptable because the work runs in a
  BullMQ processor (not on the request path) and X API rate limits
  provide natural backpressure.
- **Compound unique index for items**: the `(userId, xTweetId)` unique
  index combined with 409 conflict handling ensures concurrent retries
  or overlapping polls cannot create duplicate items.
- **Extract-item enqueuing is best-effort per job**: if the processor
  crashes after upserting items but before enqueuing extract-item jobs,
  the retry will re-upsert (no-op due to dedup) and enqueue. Items
  that were already enqueued on the previous attempt will produce
  duplicate extract-item jobs — the extract-item processor (milestone
  #8) must be idempotent.
- **Retry config** set via job options on `queue.add()` or Queue
  `defaultJobOptions`. The `poll-x` defaults: 5 attempts, exponential
  backoff base 30s, max 10m (per `docs/jobs.md`).
- **Version**: bump `package.json` from `0.6.0` → `0.7.0`.

## Acceptance Criteria

- [ ] `WorkersModule` exists with `PollXProcessor` consuming the
      `poll-x` queue.
- [ ] Processor refreshes tokens (via XSource → AuthService internally),
      calls `XSource.fetchLikes` and `XSource.fetchBookmarks`, upserts
      `items` (deduped on `xTweetId`), updates user cursors, enqueues
      `extract-item` for items with non-empty `urls`.
- [ ] `AuthExpiredError` from XSource is caught; job returns without
      retrying (user is already marked `auth_expired` by AuthService).
- [ ] Retries per `docs/jobs.md` (5 attempts, exponential 30s base,
      10m cap).
- [ ] Logs `userId`, `attempt`, `durationMs`, `newLikes`, `newBookmarks`,
      `newItems`, `extractJobsEnqueued`.
- [ ] E2E test using a stub `XSource` injected via the Nest test
      module verifies: items created, cursors updated, extract-item
      jobs enqueued for items with URLs, no extract jobs for items
      without URLs.
- [ ] `UsersRepo.updateCursors` method added and unit tested.
- [ ] `ItemsRepo.upsertMany` deduplicates on `(userId, xTweetId)`.
- [ ] `package.json` version bumped `0.6.0` → `0.7.0`.
- [ ] `bun test`, `bunx tsc --noEmit`, and `bunx biome lint .` are
      green.
