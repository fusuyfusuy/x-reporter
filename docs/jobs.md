# Background jobs (BullMQ)

All background work runs through BullMQ on Redis. The HTTP layer never blocks
on third-party calls (X, Firecrawl, OpenRouter) — it enqueues jobs and
returns.

## Queues

| Queue          | Producer                              | Consumer                          |
|----------------|---------------------------------------|-----------------------------------|
| `poll-x`       | `ScheduleService` (repeatable)        | `PollXProcessor`                  |
| `extract-item` | `PollXProcessor`                      | `ExtractItemProcessor`            |
| `build-digest` | `ScheduleService` (repeatable) + `POST /digests/run-now` | `BuildDigestProcessor` |

## Repeatable jobs

`ScheduleService.upsertJobsForUser(userId)` is called when:
- A user completes OAuth (`/auth/x/callback`).
- A user changes cadence (`PATCH /me`).
- A user is unpaused (future).

It registers two repeatable jobs per user, keyed by stable BullMQ
**job scheduler ids** so re-registering is idempotent:

| Scheduler id                 | Queue         | Interval                       |
|------------------------------|---------------|--------------------------------|
| `user:{userId}:poll`         | `poll-x`      | `user.pollIntervalMin` minutes |
| `user:{userId}:digest`       | `build-digest`| `user.digestIntervalMin` minutes |

`ScheduleService` uses BullMQ 5.x's **Job Scheduler API**
(`queue.upsertJobScheduler(id, repeatOpts, template)`), not the older
`addRepeatable` / `removeRepeatableByKey` pair. The newer API is the
"replace on cadence change" semantic the project needs out of the box:
re-upserting with the same scheduler id but a different `every` value
leaves exactly one entry behind, not two. The older `removeRepeatableByKey`
path is deprecated in BullMQ 5.x and slated for removal in 6.

The cadence interval falls back to the documented defaults
(`DEFAULT_POLL_INTERVAL_MIN = 60`, `DEFAULT_DIGEST_INTERVAL_MIN = 1440`,
imported from `src/users/cadence.constants.ts`) when the user row has no
cadence value set. The scheduler id is stable across cadence changes —
the `every` value changes, the id does not — which is why a re-upsert
overwrites instead of duplicating.

`removeJobsForUser(userId)` calls `queue.removeJobScheduler(id)` for both
schedulers. The remove call is idempotent: BullMQ returns `false` for
unknown ids without throwing, so calling `removeJobsForUser` for a user
who never had repeatables is a no-op. This is what makes
`AuthService.failAuth` safe to call unconditionally.

`removeJobsForUser` is called from:
- `AuthService.failAuth(userId)`, after a successful
  `setStatus('auth_expired')` transition. A queue outage during removal
  is logged at `warn` and swallowed so it never masks the original
  auth failure.
- (reserved) a future user-delete endpoint.

## Job payloads

### `poll-x`
```ts
type PollXJob = { userId: string };
```

### `extract-item`
```ts
type ExtractItemJob = { userId: string; itemId: string };
```

### `build-digest`
```ts
type BuildDigestJob = {
  userId: string;
  // when omitted, processor uses [now - digestIntervalMin, now]
  windowStart?: string; // ISO
  windowEnd?: string;   // ISO
};
```

## Retry policy

| Queue          | Attempts | Backoff                              |
|----------------|----------|--------------------------------------|
| `poll-x`       | 5        | exponential, base 30s, max 10m       |
| `extract-item` | 4        | exponential, base 15s, max 5m        |
| `build-digest` | 3        | exponential, base 60s, max 10m       |

`removeOnComplete: { age: 86400, count: 1000 }` and
`removeOnFail: { age: 7 * 86400 }` for all queues.

## Processor responsibilities

### `PollXProcessor`
1. Load user + decrypted tokens. Refresh if expired. If refresh fails, mark
   `status = auth_expired`, remove repeatable jobs, return.
2. `XSource.fetchLikes(user.lastLikeCursor)` and
   `XSource.fetchBookmarks(user.lastBookmarkCursor)`.
3. For each tweet, upsert `items` (skip on `xTweetId` unique conflict).
4. For each new item with non-empty `urls`, enqueue `extract-item`.
5. Persist new cursors atomically with the user record.

### `ExtractItemProcessor`
1. Load the item.
2. For each URL, call `ArticleExtractor.extract(url)`. Persist `articles`.
3. Set `item.enriched = true`.
4. Failures on individual URLs are logged but do not fail the job unless *all*
   URLs fail (retry the whole job in that case).

### `BuildDigestProcessor`
1. Resolve window: `windowEnd = job.windowEnd ?? now`,
   `windowStart = job.windowStart ?? windowEnd - user.digestIntervalMin`.
2. Load enriched items in window with their articles.
3. If `items.length === 0`, no-op (do not write an empty digest).
4. Run `DigestGraph` (see [llm-and-graph.md](./llm-and-graph.md)).
5. Persist `digests` row with `markdown`, `itemIds`, `model`, token usage.

## Concurrency

Default per-process concurrency:

| Queue          | Concurrency |
|----------------|-------------|
| `poll-x`       | 5           |
| `extract-item` | 10          |
| `build-digest` | 2           |

Tunable via env vars (see [configuration.md](./configuration.md)).

## Observability

Every processor logs:
- `jobId`, `queue`, `userId`, `attempt`, `durationMs`.
- For `build-digest`: `tokensIn`, `tokensOut`, `model`, `itemCount`.
- Failures log the error class + message and the BullMQ retry decision.

A future issue (not in v1) will add Bull Board for queue inspection.
