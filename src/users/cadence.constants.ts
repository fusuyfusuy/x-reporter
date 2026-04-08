/**
 * Documented defaults for the cadence fields (`pollIntervalMin` and
 * `digestIntervalMin`). Mirrors `data-model.md` (the schema marks both
 * fields optional so the app-layer default applies to never-patched
 * users) and `api.md` (the example response uses 60 / 1440).
 *
 * These constants live in their own file — rather than directly inside
 * `users.service.ts` — because both `UsersService` and `ScheduleService`
 * need them, and importing `users.service.ts` from `schedule.service.ts`
 * would create a cycle (`UsersService` injects `ScheduleService`, so
 * `schedule.service.ts` cannot depend back on `users.service.ts` at
 * module evaluation time without blowing up the test runner's module
 * graph).
 *
 * `users.service.ts` re-exports these constants under the same public
 * names (`DEFAULT_POLL_INTERVAL_MIN` / `DEFAULT_DIGEST_INTERVAL_MIN`)
 * so existing consumers that imported them from there continue to
 * work unchanged.
 */

/** Default poll-x interval for a user with no cadence set, in minutes. */
export const DEFAULT_POLL_INTERVAL_MIN = 60;

/** Default build-digest interval for a user with no cadence set, in minutes. */
export const DEFAULT_DIGEST_INTERVAL_MIN = 1440;
