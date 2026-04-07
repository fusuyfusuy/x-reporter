---
trigger: "GitHub issue #5 — feat(queue): BullMQ infra + ScheduleService. Replace the ScheduleService stub from #4 with a real BullMQ-backed implementation: QueueModule exposing Queue instances for poll-x, extract-item, build-digest; Redis connection from REDIS_URL; idempotent ScheduleService.upsertJobsForUser registering user:{id}:poll and user:{id}:digest repeatable jobs at the user's intervals (replacing on cadence change); removeJobsForUser called on user delete / auth_expired; wired post-callback in AuthService and post-PATCH in UsersService (#4 already wires PATCH); /health pings Redis next to Appwrite."
type: feat
branch: feat/bullmq-queues
base-branch: main
created: 2026-04-07
version-bump: minor
---

## Related Files
Existing files to touch:
- src/schedule/schedule.service.ts — replace the stub (currently only logs) with the real BullMQ-backed impl
- src/schedule/schedule.service.test.ts — replace stub tests with real tests using a fake Queue
- src/schedule/schedule.module.ts — wire QueueModule and Redis connection
- src/config/env.ts — tighten REDIS_URL from optional → required
- src/config/env.test.ts — assert REDIS_URL is now required
- src/common/logger.test.ts — add REDIS_URL to test env
- src/app.module.test.ts — add REDIS_URL to test env, possibly inject a fake QueueModule for the e2e-lite test
- src/auth/auth.service.ts — after handleCallback persists tokens + upserts user, call this.schedule.upsertJobsForUser(user.id). Inject ScheduleService via constructor (it already lives in a global module).
- src/auth/auth.service.test.ts — assert post-callback schedule call with a fake ScheduleService
- src/auth/auth.service.ts — also call schedule.removeJobsForUser(userId) inside failAuth() after setStatus('auth_expired') succeeds, so a stuck user stops being polled
- src/health/health.controller.ts — add Redis ping next to Appwrite ping. Same shape: never throws, returns { redis: { status: 'ok' | 'down', error? } }
- src/health/health.controller.test.ts — cover Redis pass/fail with a fake redis client
- src/health/health.module.ts — provide whatever the controller injects for the redis ping (likely a small RedisHealth helper from the queue module, NOT the ioredis client directly, to keep the SDK contained)
- bun.lock — bullmq + ioredis lockfile additions
- package.json — bullmq + ioredis deps + version bump 0.4.0 → 0.5.0

New files to create:
- src/queue/queue.module.ts — global module that provides Redis connection + three Queue instances under DI tokens. Closes connection in onModuleDestroy.
- src/queue/queue.tokens.ts — DI tokens: POLL_X_QUEUE, EXTRACT_ITEM_QUEUE, BUILD_DIGEST_QUEUE, REDIS_CLIENT, REDIS_HEALTH (or similar). Plus a typed `QueueName` literal union for use in tests/specs.
- src/queue/redis.connection.ts — factory that builds an ioredis Connection from REDIS_URL with sensible defaults (maxRetriesPerRequest: null is REQUIRED by BullMQ workers; lazyConnect for cleaner test boot). Exposes a small `pingRedis(client): Promise<{status:'ok'|'down', error?}>` helper.
- src/queue/redis.connection.test.ts — connection factory + ping helper unit tests with a fake/stub
- src/queue/queue.module.test.ts — DI registration sanity check
- docs/specs/bullmq.md — milestone spec (per autoDocs directive)

## Relevant Docs
- docs/jobs.md#repeatable-jobs — exact contract: job names per user (user:{id}:poll, user:{id}:digest), repeat every pollIntervalMin / digestIntervalMin minutes, the three queues and their consumers
- docs/configuration.md — REDIS_URL env var
- docs/architecture.md — queue/worker module placement
- docs/swe-config.json — hexagonal: BullMQ + ioredis types must NOT leak past src/queue/ and src/schedule/. AuthService and UsersService must continue to depend only on ScheduleService.
- docs/implementation-plan.md#5 — milestone #5 acceptance criteria

## Related Issues
- #5 feat(queue): BullMQ infra + ScheduleService (open) — this issue
- #1, #2, #3, #4 (merged)
- #7 (next) — poll-x worker consumes the queue + AuthService.getValidAccessToken
- #11 — build-digest worker consumes the queue
- Replaces the stub ScheduleService landed in #4

## Scope
Stand up the BullMQ queue layer end-to-end so subsequent worker milestones can implement processors against real queues.

**Acceptance criteria (from issue #5):**
- [ ] QueueModule exposes BullMQ Queue instances for poll-x, extract-item, build-digest
- [ ] Connection configured from REDIS_URL
- [ ] ScheduleService.upsertJobsForUser(userId) is idempotent: registers user:{id}:poll and user:{id}:digest repeatable jobs at the user's intervals; replaces existing entries on cadence change; removes both on user delete / auth_expired
- [ ] Wired into AuthModule (post-callback) and UsersModule (post-PATCH; already done in #4 — verify it still calls through)
- [ ] /health now also pings Redis

**Out of scope (deferred):**
- The actual processors (poll-x: #7, extract-item: #8, build-digest: #11) — only stand up the queues here, do not register Workers
- Dead-letter queues / retry-delay tuning beyond BullMQ defaults (exponential backoff with maxAttempts is fine for #5; #7 will revisit)
- Bull Board / observability dashboards
- Multi-tenant queue isolation

**Architecture / implementation notes:**
- **BullMQ repeatable jobs:** use `queue.add(jobName, data, { repeat: { every: ms }, jobId: 'user:{id}:poll' })`. To make upsert idempotent with cadence changes, the contract is "remove existing repeatable matching this jobId, then add". Use `queue.removeRepeatableByKey(...)` or list-and-match — pick whichever pattern BullMQ 5.x officially recommends. Cover with a unit test that calls upsert twice with different intervals and asserts only one repeatable exists with the new interval.
- **Cadence source:** ScheduleService MUST read pollIntervalMin / digestIntervalMin from UsersRepo.findById(userId) inside upsertJobsForUser. Defaults (60 / 1440) come from UsersService.DEFAULT_POLL_INTERVAL_MIN / DEFAULT_DIGEST_INTERVAL_MIN — import them, do NOT hardcode. If the user is missing, treat the same as removeJobsForUser (no-op + warn log) since the workers would just fail anyway.
- **removeJobsForUser:** new method on ScheduleService. Removes both repeatables for the user. Idempotent (no error if jobs don't exist). Called from AuthService.failAuth (post setStatus auth_expired) and reserved for a future user-delete endpoint.
- **AuthService wiring:** AuthService gains a ScheduleService dependency. handleCallback's last step (after token persistence + session cookie minting) calls schedule.upsertJobsForUser(user.id). If the schedule call throws, log warn and rethrow — auth callback stays a 502 in that case (same controller mapping pattern as the other upstream dependencies). Update auth.service.test.ts to inject a fake ScheduleService and assert the call.
- **UsersService wiring:** already calls schedule.upsertJobsForUser in #4. Verify the e2e test still passes after the stub is replaced with the real impl + a fake Queue. No new changes expected here besides making sure the fake-Queue test setup is reusable.
- **Hexagonal containment:** BullMQ types live ONLY in src/queue/ and src/schedule/. ScheduleService's public method signatures (upsertJobsForUser, removeJobsForUser) stay free of Queue / Job / RepeatOptions types. The queue module exports DI tokens, not classes — consumers inject by token.
- **Redis connection:** single ioredis instance shared across the three queues + the health ping. Build it from REDIS_URL with `maxRetriesPerRequest: null` (BullMQ requires this for workers in #7) and `enableReadyCheck: false` (avoids slow boot in CI). Expose via a REDIS_CLIENT DI token. Close in onModuleDestroy so test runs don't leak handles.
- **Health ping:** model after AppwriteService.ping — never throws, returns discriminated union. Use redis.ping() under the hood. /health body becomes { status: 'ok', appwrite: {...}, redis: {...} }. Keep returning HTTP 200 even when subsystems are down (existing policy).
- **Versioning:** bump package.json minor: 0.4.0 → 0.5.0.
- **Quality gate:** `bun test`, `bunx tsc --noEmit`, `bunx biome lint .` must all be green.
