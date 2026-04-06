---
title: "Appwrite SDK wrapper + collection bootstrap"
type: spec
tags: [appwrite, persistence, bootstrap, health, schema]
created: 2026-04-06
updated: 2026-04-06
issue: 2
---

## Behavior

This milestone lays the persistence foundation. It introduces:

1. An `AppwriteModule` (`src/appwrite/appwrite.module.ts`) that registers a
   single `AppwriteService` provider, configured from the validated `Env`.
2. An `AppwriteService` (`src/appwrite/appwrite.service.ts`) that:
   - Constructs a `node-appwrite` `Client` once at boot using
     `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and `APPWRITE_API_KEY`.
   - Constructs `Databases` (and any other future SDK service handles)
     once and exposes them via typed helper methods.
   - Exposes a `databaseId` getter so callers don't have to thread the env.
   - Exposes a `ping()` method that performs a lightweight `databases.get`
     against `APPWRITE_DATABASE_ID` and returns a discriminated union
     `{ status: 'ok' } | { status: 'down', error: string }`.
   - Hides raw SDK types from callers wherever practical: typed helper
     methods accept and return plain TypeScript shapes, never the SDK's
     `Models.Document<T>` envelope. (Where the underlying SDK type is
     unavoidable on a returned value, the helper wraps and unwraps it.)
3. An idempotent `scripts/setup-appwrite.ts` that materializes the full
   schema from `docs/data-model.md`:
   - Creates the `xreporter` database if absent.
   - For each collection in `users`, `tokens`, `items`, `articles`, `digests`:
     creates the collection if absent, then ensures every attribute and every
     index from the doc table exists.
   - Treats `409 Conflict` (already exists) as success at every step.
   - Polls each attribute until `status === 'available'` before creating any
     index that depends on it (Appwrite requires attributes to be available
     before they can be indexed).
   - Logs each action it takes (created vs. skipped) so a re-run is visibly
     a no-op.
   - Exits non-zero if any non-409 error bubbles up.
4. `HealthModule` is extended:
   - `AppwriteModule` is registered globally from `AppModule` via
     `AppwriteModule.forRoot(env)`, so its `AppwriteService` provider is
     visible to every module without `HealthModule` having to import
     `AppwriteModule` itself. `HealthController` injects `AppwriteService`
     directly, and `HealthModule` stays env-agnostic.
   - `GET /health` calls `AppwriteService.ping()` and includes its result in
     the response under the `appwrite` key.
   - The endpoint still returns HTTP 200 even when the Appwrite ping fails;
     the JSON body distinguishes the subsystem state. (Future milestones may
     change this to 503 once a uniform health policy is set.)
5. `src/config/env.ts` is tightened:
   - `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and `APPWRITE_API_KEY` move
     from `optional()` to required.
   - `APPWRITE_DATABASE_ID` keeps its default of `xreporter`.
   - The schema's milestone comment is updated to reflect the new state.
6. `package.json` version bumps from `0.1.0` to `0.2.0` (minor bump per
   `versioning` rule in `swe-config.json`).

## Constraints

- **Hexagonal architecture.** Appwrite is documented in `interfaces.md` as
  a foundation, not a swap-point. There is no `AppwritePort` interface and
  no separate adapter file. The constraint that matters is: **no Appwrite
  SDK type may appear in any future domain layer module.** `AppwriteService`
  satisfies this by being the only place that imports from `node-appwrite`,
  and by exposing typed helpers rather than re-exporting SDK types.
- **No SDK types in `src/appwrite/index` or any module's public surface.**
  `AppwriteService` may use SDK types internally, but its method signatures
  use plain TypeScript shapes that are valid across SDK upgrades.
- **Idempotency.** The bootstrap script must be safe to re-run any number of
  times against the same project. Re-running after a clean run produces no
  errors and creates no duplicates.
- **Validate env at boundaries.** No new validation logic beyond extending
  the existing zod schema. Tightened vars are caught at `loadEnv()`.
- **Fail fast on bad config.** Booting with missing Appwrite vars must abort
  before binding the HTTP server (already enforced by `loadEnv()`).
- **No secrets in logs.** The setup script logs collection/attribute/index
  ids only; never the API key, never the endpoint host with credentials.
- **Bun runtime.** The bootstrap script runs under Bun (`bun run
  scripts/setup-appwrite.ts`). It MUST NOT depend on Node-only built-ins
  beyond what `node-appwrite` already requires.
- **Schema is doc-driven.** The script's collection / attribute / index
  definitions live in a single TypeScript module and exactly match the
  tables in `docs/data-model.md`. When the schema changes, the doc and the
  script change in the same PR (per `documentation` directive).
- **Health endpoint stays cheap.** `AppwriteService.ping()` uses
  `databases.get(databaseId)` — a single round-trip — and never throws.
  Errors are caught and surfaced as `{ status: 'down', error }`.
- **Out of scope (deferred):**
  - Token encryption (#3).
  - Any read or write of documents at runtime beyond the bootstrap script
    and the health ping.
  - Migration tooling beyond idempotent ensure-exists (no rotation, no
    backfill, no destructive operations).
  - A `503` health response on subsystem failure — keep the current `200`
    + JSON body shape for now.

## Acceptance criteria

- [ ] `src/appwrite/appwrite.module.ts` exports `AppwriteModule` registering
      `AppwriteService` as a provider, constructed from `Env`.
- [ ] `src/appwrite/appwrite.service.ts` exports `AppwriteService` with at
      least: `databaseId` (getter), `ping()`, and access to the underlying
      typed helper(s) needed by `setup-appwrite.ts` (e.g., a `databases`
      accessor).
- [ ] `src/appwrite/appwrite.service.test.ts` covers:
      - `ping()` returns `{ status: 'ok' }` when the SDK call resolves.
      - `ping()` returns `{ status: 'down', error }` when the SDK call rejects.
      - `databaseId` getter returns the configured value.
- [ ] `scripts/setup-appwrite.ts` exists and exports a `runSetup(env)`
      function that:
      - Creates the database if missing, ignores `409`.
      - Creates each collection if missing, ignores `409`.
      - Creates each attribute if missing, ignores `409`, waits for
        `status === 'available'` before continuing.
      - Creates each index if missing, ignores `409`.
      - Logs each step with a clear `created` vs `skipped` marker.
- [ ] Re-running `bun run scripts/setup-appwrite.ts` after a successful run
      produces no errors and only `skipped` log lines (verifiable by unit
      test against a fake `AppwriteService`).
- [ ] `src/config/env.ts`: `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, and
      `APPWRITE_API_KEY` are required (no `.optional()`); env tests updated
      to assert that omitting them now throws.
- [ ] `src/health/health.module.ts` stays env-agnostic and does NOT import
      `AppwriteModule`; the `AppwriteService` provider is supplied globally
      by `AppwriteModule.forRoot(env)` registered from `AppModule`.
- [ ] `src/health/health.controller.ts` injects `AppwriteService`, calls
      `ping()`, and returns `{ status: 'ok', appwrite: <ping result> }`.
- [ ] `src/health/health.controller.test.ts` covers the new shape with both
      a passing and failing fake `AppwriteService`.
- [ ] `src/app.module.ts` registers `AppwriteModule.forRoot(env)` as a
      global module so any controller (including `HealthController`) can
      inject `AppwriteService` without importing `AppwriteModule` directly.
- [ ] `package.json` version is `0.2.0`.
- [ ] `bunx tsc --noEmit` and `bun test` are green.
- [ ] `bunx biome lint .` reports no new findings on changed files.
