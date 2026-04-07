---
title: "BullMQ infra + ScheduleService"
type: spec
tags: [queue, bullmq, redis, schedule, ioredis, hexagonal, health]
created: 2026-04-07
updated: 2026-04-07
issue: 5
---

## Behavior

This milestone stands up the BullMQ queue layer end-to-end so subsequent
worker milestones (#7 `poll-x`, #8 `extract-item`, #11 `build-digest`)
can implement their processors against real queues. It also replaces
the stub `ScheduleService` from milestone #4 with a real BullMQ-backed
implementation that synchronises per-user repeatable jobs with the
user's current cadence.

Scope:

1. **`QueueModule`** (`src/queue/queue.module.ts`) — a `@Global()` module
   that owns the BullMQ lifecycle for the whole process. Provides:
   - A single shared `ioredis` client built from `env.REDIS_URL`,
     exposed under the `REDIS_CLIENT` DI token. The same client is
     reused as the BullMQ `connection` for every queue *and* as the
     Redis health probe, so the process has exactly one Redis
     TCP connection in normal operation instead of one per queue.
   - Three BullMQ `Queue` instances:
     - `POLL_X_QUEUE` → `poll-x`
     - `EXTRACT_ITEM_QUEUE` → `extract-item`
     - `BUILD_DIGEST_QUEUE` → `build-digest`

     Each queue is a separate DI token (not a class) so consumers
     (today: `ScheduleService`; later: the worker modules in #7/#8/#11)
     inject by token and never import BullMQ types outside the queue
     module.
   - A `REDIS_HEALTH` token backed by a small `RedisHealth` helper
     whose only method is `ping()`. Used by `HealthController` so the
     controller can report Redis liveness without importing `ioredis`
     directly. Mirrors the `AppwriteService.ping` pattern: never
     throws, always returns a discriminated `{status: 'ok' | 'down'}`
     union.
   - `onModuleDestroy` closes all three queues and quits the shared
     Redis client so test runs (and graceful shutdowns) do not leak
     Redis handles.

2. **Redis connection factory** (`src/queue/redis.connection.ts`) —
   builds the `ioredis` client from the parsed `REDIS_URL` with the
   two options BullMQ 5.x requires for workers to behave correctly:
   - `maxRetriesPerRequest: null` — BullMQ workers (arriving in #7)
     refuse to start without this, and setting it at construction time
     avoids a footgun later.
   - `enableReadyCheck: false` — avoids slow boot in CI where Redis
     takes a moment to accept commands after starting.

   Also exports `pingRedis(client)` which runs `client.ping()` inside
   a try/catch and returns the health-ping discriminated union.

3. **`ScheduleService` real impl** (`src/schedule/schedule.service.ts`) —
   replaces the milestone-#4 stub without changing its public surface.
   Public methods:

   ```ts
   upsertJobsForUser(userId: string): Promise<void>;
   removeJobsForUser(userId: string): Promise<void>;
   ```

   Both methods are `Promise<void>` and take nothing but a user id —
   no BullMQ `JobsOptions`, `Queue`, or `RepeatOptions` types leak to
   the caller. Consumers (`AuthService`, `UsersService`) still depend
   only on `ScheduleService`.

   `upsertJobsForUser(userId)`:
   a. Loads the user via `UsersRepo.findById(userId)`.
   b. If the user is missing, logs at warn and returns (no-op). No
      throw — a deleted user does not merit an error on a routine
      cadence sync, and the workers would fail loudly anyway.
   c. Resolves the cadence using
      `user.pollIntervalMin ?? DEFAULT_POLL_INTERVAL_MIN` and
      `user.digestIntervalMin ?? DEFAULT_DIGEST_INTERVAL_MIN`
      (imported from `UsersService`, not hardcoded).
   d. For each of the two repeatable jobs
      (`user:{id}:poll` on `poll-x`, `user:{id}:digest` on `build-digest`),
      removes any existing scheduler for that jobId (idempotent) and
      adds a fresh one at the computed interval. The "remove then add"
      contract is what makes cadence changes propagate: after an
      `upsertJobsForUser` call, there is exactly one repeatable entry
      per jobId and it reflects the user's current interval.
   e. The same method is safe to call twice in a row — the second
      call removes the entry added by the first and re-adds it with
      the same interval, a no-op from the user's perspective.

   `removeJobsForUser(userId)`:
   a. Removes both repeatables (`user:{id}:poll`, `user:{id}:digest`)
      from their respective queues.
   b. Idempotent: removing a repeatable that does not exist is a
      no-op, not an error. A user whose repeatables were already
      cleaned up (e.g. a previous `failAuth`) can be passed to
      `removeJobsForUser` any number of times.
   c. Called from `AuthService.failAuth(userId)` after the successful
      `setStatus('auth_expired')` transition, so a stuck user stops
      being polled.

4. **`AuthService` wiring** (`src/auth/auth.service.ts`) — `AuthService`
   gains a `ScheduleService` dependency (injected by `AuthModule.forRoot`).
   - After `handleCallback` persists the user + encrypted tokens and
     mints the session cookie, it calls
     `schedule.upsertJobsForUser(user.id)` as the last step. If the
     schedule call throws, the method logs at warn and rethrows so
     the controller maps the callback to the existing upstream-502
     path instead of silently completing a half-wired sign-in.
   - Inside `failAuth`, after the `setStatus('auth_expired')` call
     succeeds, `schedule.removeJobsForUser(userId)` runs inside its
     own try/catch so a repeatable-removal failure cannot mask the
     original auth failure (same philosophy as the existing
     `setStatus` try/catch).

5. **`HealthController` wiring** (`src/health/health.controller.ts`) —
   the `/health` response becomes
   `{status: 'ok', appwrite: {...}, redis: {...}}`. The controller
   injects the `REDIS_HEALTH` token and calls `.ping()`. Same policy
   as the existing Appwrite ping: the HTTP status stays 200 even
   when a subsystem is down; the JSON body tells the operator which
   subsystem is degraded.

6. **`env.ts` tightening** — `REDIS_URL` changes from optional to
   required. The schema already validates the `url()` shape; this
   milestone removes `.optional()` so boot fails fast on a missing
   Redis URL.

## Constraints

- **Hexagonal containment**: BullMQ and `ioredis` types MUST NOT appear
  outside `src/queue/` and `src/schedule/`. `ScheduleService` public
  method signatures stay free of `Queue`, `Job`, `JobScheduler`,
  `RepeatOptions`, `ioredis` types, etc.
- **Single shared Redis client**: exactly one `ioredis` client for the
  whole process. The three queues share it as the BullMQ `connection`,
  and the Redis health probe uses the same client. `onModuleDestroy`
  quits it once.
- **No worker registration in this milestone**: stand up the queue
  producers and `ScheduleService`. `BullMQ.Worker` registration is
  deferred to #7 / #8 / #11. A `bun run start:dev` against this
  milestone's code does not consume any jobs.
- **`ScheduleService.upsertJobsForUser` must read the user row** —
  it cannot take cadence values as arguments, because the public
  surface is `(userId) => Promise<void>`. The caller
  (`UsersService.updateCadence`, `AuthService.handleCallback`) passes
  only the user id.
- **Cadence defaults**: import
  `DEFAULT_POLL_INTERVAL_MIN` / `DEFAULT_DIGEST_INTERVAL_MIN` from
  `src/users/users.service.ts`. Do NOT hardcode `60 / 1440` inside
  `ScheduleService`.
- **Idempotency contract**: calling `upsertJobsForUser` N times in a
  row for the same user MUST leave the queue in the same state as a
  single call. Calling `upsertJobsForUser` with a different cadence
  MUST replace the existing entry (not create a second repeatable).
  Calling `removeJobsForUser` for a user with no repeatables MUST
  NOT throw.
- **BullMQ 5.x job scheduler API**: BullMQ 5 replaced the
  `addRepeatable`/`removeRepeatableByKey` pair with the Job Scheduler
  API (`upsertJobScheduler`, `removeJobScheduler`). The real impl uses
  the Job Scheduler API so the jobId/scheduler key stays stable across
  cadence changes — reconfiguring an existing scheduler replaces it,
  which is exactly the "remove then add" contract the milestone
  needs.
- **Health policy**: `/health` keeps its existing contract — HTTP 200
  regardless of subsystem state, discriminated union per subsystem in
  the body. Do not throw out of the Redis ping; convert any failure
  to `{status: 'down', error: string}`.
- **Version**: bump `package.json` from `0.4.0` → `0.5.0`.

## Acceptance Criteria

- [ ] `QueueModule` provides three BullMQ queues (`poll-x`,
      `extract-item`, `build-digest`) under distinct DI tokens, plus a
      shared Redis client and a Redis health helper.
- [ ] Redis connection is built from `env.REDIS_URL` with
      `maxRetriesPerRequest: null` and `enableReadyCheck: false`.
- [ ] `env.REDIS_URL` is now required (boot fails fast if missing).
- [ ] `ScheduleService.upsertJobsForUser(userId)` reads the user's
      cadence from `UsersRepo.findById`, falls back to the documented
      defaults, and registers both repeatable jobs at the computed
      intervals. Unit-tested end-to-end with a fake queue.
- [ ] `upsertJobsForUser` is idempotent: two calls with the same
      cadence → one entry. Two calls with different cadences → one
      entry at the new cadence. Proven by a unit test that asserts
      exactly one scheduler exists after back-to-back calls with
      different intervals.
- [ ] `ScheduleService.removeJobsForUser(userId)` removes both
      repeatables and is idempotent (no error on missing entries).
- [ ] `AuthService.handleCallback` calls
      `schedule.upsertJobsForUser(user.id)` as its last step. A
      schedule throw propagates (controller → 502).
- [ ] `AuthService.failAuth` calls `schedule.removeJobsForUser(userId)`
      after a successful `setStatus('auth_expired')`. A removal
      failure is logged and swallowed (does not mask the original
      error).
- [ ] `UsersService.updateCadence` still calls
      `schedule.upsertJobsForUser` via the existing path — no new
      wiring, just confirm it works against the real impl with a
      fake queue in its tests.
- [ ] `GET /health` body includes `redis: {status: 'ok'|'down', error?}`
      alongside `appwrite`. HTTP status stays 200 even if Redis is
      down.
- [ ] `package.json` version bumped `0.4.0` → `0.5.0`.
- [ ] `bun test`, `bunx tsc --noEmit`, and `bunx biome lint .` are
      green.
