---
title: "/me endpoints + cadence settings"
type: spec
tags: [users, me, cadence, session, guard, schedule, zod]
created: 2026-04-07
updated: 2026-04-07
issue: 4
---

## Behavior

This milestone adds the user-facing read/write surface for the cadence
settings persisted on the `users` collection (`pollIntervalMin` and
`digestIntervalMin`), gated by the session cookie issued by the OAuth2
callback in milestone #3. It also lands a stub `ScheduleService` whose
real BullMQ-backed implementation arrives in milestone #5 — wiring the
side effect now means #5 only has to swap the body of one method.

It introduces:

1. **`SessionGuard`** (`src/common/session.guard.ts`) — a Nest
   `CanActivate` guard. Reads the `xr_session` cookie via the existing
   `parseCookies` helper, verifies the HMAC signature with
   `verifyCookieValue<SessionCookiePayload>`, and on success attaches
   `{ id }` to `req.user`. Any of the following produces `401`:
   - missing `Cookie` header
   - missing `xr_session` cookie
   - signature mismatch (tampered cookie)
   - malformed payload (no `userId` string)

   Lives in `src/common/` because the digest endpoints in milestone #11
   reuse it. The guard is deliberately Passport-free — it has zero
   third-party dependencies and zero side effects beyond reading a
   header and writing `req.user`.

2. **`UsersModule`** (`src/users/users.module.ts`) wired into `AppModule`,
   exposing `UsersController` and providing `UsersService`, `UsersRepo`,
   and the `SessionGuard`.

3. **`UsersController`** (`src/users/users.controller.ts`) with two
   endpoints, both behind `SessionGuard`:
   - `GET /me` — loads the user via `UsersRepo.findById(req.user.id)`
     and returns the documented `/me` payload.
   - `PATCH /me` — validates the body with a strict zod schema
     (`pollIntervalMin: int >= 5` optional, `digestIntervalMin: int >= 15`
     optional, at least one field required, unknown keys rejected),
     calls `UsersService.updateCadence`, and returns the same `/me`
     payload reflecting the post-update state.

4. **`UsersService`** (`src/users/users.service.ts`) — the orchestrator
   for the patch flow. `updateCadence(userId, patch)`:
   1. Calls `UsersRepo.updateCadence`. If this throws, surfaces it as-is
      and does NOT call schedule (no half-applied state).
   2. Calls `ScheduleService.upsertJobsForUser(userId)`. If this throws,
      logs at `warn` and rethrows a typed `ScheduleSyncError` so the
      controller can map it to `502` (same upstream-failure pattern
      `AuthController` already uses).

5. **`ScheduleService` stub** (`src/schedule/schedule.service.ts`) —
   `@Injectable()` class with a single method
   `async upsertJobsForUser(userId: string): Promise<void>` that logs at
   info and resolves. The public surface is intentionally adapter-free
   (no BullMQ types, no Redis types) so milestone #5 can replace the
   body with the real implementation without touching any consumer.

6. **`ScheduleModule`** (`src/schedule/schedule.module.ts`) — registered
   as a global module so #5's BullMQ wiring (which has its own
   construction-time dependencies) can plug in without forcing every
   consumer to import a new module.

7. **`UsersRepo` additions:**
   - `findById(id)` — already present from #3.
   - `updateCadence(id, { pollIntervalMin?, digestIntervalMin? })` —
     new. Updates only the provided fields and returns the post-update
     `UserRecord`. Both fields are optional at the DB level (per
     `data-model.md`) so the documented defaults take effect when a
     row has never been patched.

The `UserRecord` shape is extended with optional `pollIntervalMin` and
`digestIntervalMin` fields. When absent on the document, the controller
substitutes the documented defaults (60 / 1440) before responding so
clients always see numbers, never `undefined`.

## Constraints

- `pollIntervalMin` is an integer `>= 5`. Defaults to `60` when unset.
- `digestIntervalMin` is an integer `>= 15`. Defaults to `1440` when unset.
- Both fields are optional in the DB row. The repo never writes them
  unless the patch supplies them.
- Validation lives at the HTTP boundary (zod), not in the service or
  the repo. Invalid bodies produce `400` with the zod error tree under
  the standard error envelope defined in
  [api.md#errors](../api.md#errors) — i.e. `{ error: { code, message,
  details } }` with `code: 'validation_failed'` and the zod issue tree
  in `details`. They never reach the repo.
- A `PATCH /me` body MUST provide at least one of `pollIntervalMin` or
  `digestIntervalMin`. Empty bodies (`{}`) and bodies containing only
  unknown keys are rejected with `400 validation_failed` by the same
  strict zod schema, so `UsersService.updateCadence` is only ever
  called when at least one valid cadence field was supplied.
- The session cookie name (`xr_session`) and HMAC secret are sourced
  from the constants and config already established in #3. The guard
  must not duplicate the cookie name string.
- The `/me` response shape is fixed:

  ```json
  {
    "id": "u_abc",
    "xUserId": "12345",
    "handle": "fusuyfusuy",
    "pollIntervalMin": 60,
    "digestIntervalMin": 1440,
    "status": "active",
    "createdAt": "2026-04-06T12:00:00Z"
  }
  ```

  No tokens, no cursors, no internal Appwrite fields (`$id`,
  `$createdAt`, etc.) are exposed.
- `ScheduleService.upsertJobsForUser` returns `Promise<void>`. Its
  surface must not reference `Queue`, `JobsOptions`, `Redis`, or any
  other BullMQ / Redis SDK type, so #5 can swap the implementation
  without churning consumers.
- `UsersService.updateCadence` is the single call site that combines
  the repo write with the schedule sync. Controllers do not call
  `ScheduleService` directly.

## Acceptance Criteria

- [ ] `GET /me` returns the authenticated user's profile + cadence in
  the documented shape.
- [ ] `PATCH /me` accepts `pollIntervalMin` and `digestIntervalMin`,
  validates with zod (min 5 / min 15, integers, at least one field,
  unknown keys rejected), persists, and returns the updated payload.
- [ ] After a successful `PATCH /me`,
  `ScheduleService.upsertJobsForUser` is invoked exactly once with
  the caller's user id.
- [ ] Both endpoints return `401` when the `xr_session` cookie is
  missing, malformed, or has a bad signature.
- [ ] An invalid PATCH body returns `400` with a `validation_failed`
  error code; the request never reaches the repo.
- [ ] If `UsersRepo.updateCadence` throws, the schedule sync is not
  attempted.
- [ ] If `ScheduleService.upsertJobsForUser` throws, the controller
  responds `502` and the failure is logged at `warn`.
- [ ] An e2e test mints a session cookie via `signCookieValue`, calls
  `GET /me`, `PATCH /me`, then `GET /me` again, and asserts the
  second `GET` reflects the patched cadence.
- [ ] `bun test`, `bunx tsc --noEmit`, and `bunx biome lint .` are
  green.
- [ ] `package.json` version bumped to `0.4.0`.

## Out of scope

Deferred to follow-up issues (per `docs/implementation-plan.md` and the
v1 out-of-scope list in `docs/architecture.md`):

- Real BullMQ `ScheduleService` (#5).
- `pause` / `resume` / `delete account` endpoints.
- Profile fields beyond `xUserId`, `handle`, `status`, cadence, `createdAt`.
- Multi-account.
- Rate limiting on `/me`.
- Returning queue / job state alongside the profile.
