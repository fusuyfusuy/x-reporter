---
trigger: "GitHub issue #4 — feat(users): /me endpoints + cadence settings. Implement GET /me (returns profile + cadence) and PATCH /me (validates and persists pollIntervalMin >=5, digestIntervalMin >=15), guarded by the session cookie issued in #3, with a 401 path for missing/invalid sessions, and a stub ScheduleService.upsertJobsForUser call after successful PATCH (real BullMQ impl lands in #5). E2E test must round-trip sign-in stub → GET → PATCH → GET reflects changes."
type: feat
branch: feat/me-endpoints
base-branch: main
created: 2026-04-07
version-bump: minor
---

## Related Files
Existing files to touch:
- src/users/users.repo.ts — add findById and updateCadence helpers (current repo only has upsertByXUserId + setStatus)
- src/users/users.repo.test.ts — extend with the new helper tests
- src/auth/cookies.ts — reuse parseCookies + verifyCookieValue from #3 (no changes expected)
- src/auth/auth.service.ts — SessionCookiePayload type is exported here; reuse it from the guard
- src/app.module.ts — register UsersModule and ScheduleModule
- src/app.module.test.ts — extend e2e-lite to cover the /me round-trip

New files to create:
- src/common/session.guard.ts — Nest CanActivate guard. Reads `xr_session` cookie via parseCookies, verifies signature with verifyCookieValue<SessionCookiePayload>, attaches `userId` to req. 401 on missing/invalid/tampered.
- src/common/session.guard.test.ts — 401 paths (no cookie, bad signature, malformed payload) + happy path
- src/users/users.controller.ts — GET /me, PATCH /me. Both behind SessionGuard.
- src/users/users.controller.test.ts — 401 without cookie, GET happy path, PATCH validation (zod errors → 400), PATCH happy path triggers ScheduleService.upsertJobsForUser, GET reflects updated cadence
- src/users/users.module.ts — wires controller, repo, ScheduleService
- src/users/users.service.ts — orchestrates UsersRepo + ScheduleService for the patch flow
- src/users/users.service.test.ts — service-level orchestration tests with fakes
- src/schedule/schedule.service.ts — STUB. Single method `upsertJobsForUser(userId): Promise<void>`. Logs at info, does nothing else. Real BullMQ impl is #5.
- src/schedule/schedule.module.ts — exports ScheduleService as a global module so #5 can swap impl without churn
- src/schedule/schedule.service.test.ts — stub test asserting it resolves and logs
- docs/specs/me-endpoints.md — milestone spec (per autoDocs directive)

## Relevant Docs
- docs/api.md#me — GET /me (200 with profile + cadence) and PATCH /me (zod-validated cadence) contracts; 401 without session cookie
- docs/data-model.md — users collection: pollIntervalMin (default 60, min 5), digestIntervalMin (default 1440, min 15), status, handle, xUserId
- docs/jobs.md — ScheduleService contract that #5 will implement; this milestone only stubs it
- docs/architecture.md — module layout
- docs/swe-config.json — hexagonal: ScheduleService in #5 will own the BullMQ adapter, so the stub here must keep its public surface adapter-free
- docs/implementation-plan.md#4 — milestone #4 acceptance criteria

## Related Issues
- #4 feat(users): /me endpoints + cadence settings (open) — this issue
- #1, #2, #3 (merged)
- #5 (next) — replaces ScheduleService stub with real BullMQ + ScheduleService.upsertJobsForUser implementation

## Scope
Add the user-facing read/write surface for cadence settings, gated by the session cookie issued by the OAuth callback in #3. Land a stub ScheduleService that #5 will replace, so the cadence-update side effect is wired but inert.

**Acceptance criteria (from issue #4):**
- [ ] GET /me returns the authenticated user's profile + cadence
- [ ] PATCH /me accepts pollIntervalMin (>=5) and digestIntervalMin (>=15), validates with zod, persists
- [ ] After PATCH, ScheduleService.upsertJobsForUser is called (stub OK; real call hooked in #5)
- [ ] Returns 401 without a session cookie
- [ ] E2E test: sign in stub → GET → PATCH → GET reflects changes

**Out of scope (deferred):**
- Real BullMQ ScheduleService (#5)
- Pause / resume / delete account
- Profile fields beyond what's already in the users collection
- Multi-account
- Rate limiting on /me
- Returning queue / job state alongside profile

**Architecture / implementation notes:**
- **SessionGuard:** lives in `src/common/` because it'll be reused by digest endpoints in #11. Reads the `xr_session` cookie name as a constant exported from `auth.controller.ts` (already there: `SESSION_COOKIE_NAME`). On success, attaches `userId` to `req.user = { id }` so controllers can read it via a small `@CurrentUser()` param decorator OR just `@Req()`. Keep it simple — no Passport.
- **PATCH validation:** zod schema with `pollIntervalMin: z.number().int().min(5).optional()` and `digestIntervalMin: z.number().int().min(15).optional()`. At least one field required (use `.refine`). Reject unknown keys (`.strict()`). Invalid → 400 with the zod error tree, not a 500.
- **GET /me response shape:** `{ id, xUserId, handle, pollIntervalMin, digestIntervalMin, status, createdAt }`. No tokens, no cursors, no internal fields.
- **PATCH /me response shape:** same as GET, returning the post-update state.
- **UsersRepo additions:** `findById(id)` and `updateCadence(id, { pollIntervalMin?, digestIntervalMin? })`. Use AppwriteService.databases under the hood (UsersRepo already wraps it). Cover both with tests against the existing in-memory fake pattern from users.repo.test.ts.
- **UsersService.updateCadence(userId, patch):** call repo.updateCadence, then await schedule.upsertJobsForUser(userId). If repo throws, do not call schedule. If schedule throws, log warn and rethrow as 502 from the controller — same pattern AuthController uses for upstream failures.
- **ScheduleService stub:** `@Injectable()` class with one method `async upsertJobsForUser(userId: string): Promise<void>` that calls `this.logger.log(\`schedule.upsertJobsForUser(${userId}) — stub, real impl in #5\`)`. Exported via ScheduleModule which is registered globally so future BullMQ wiring can replace it without touching consumers.
- **E2E test in app.module.test.ts:** mint a session cookie via the existing `signCookieValue(...)` helper from #3 (NOT going through /auth/x/start), call GET /me, PATCH /me, GET /me again, assert the cadence reflects the patch. Use the same Test.createTestingModule + AppwriteService override pattern that's already in app.module.test.ts.
- **Versioning:** bump package.json minor: 0.3.0 → 0.4.0.
- **Quality gate:** `bun test`, `bunx tsc --noEmit`, `bunx biome lint .` must all be green.
