---
title: "Project scaffold (Bun + NestJS)"
type: spec
tags: [scaffold, nestjs, bun, config, logger, health]
created: 2026-04-06
updated: 2026-04-06
issue: 1
---

## Behavior

The repository hosts a NestJS application running on the Bun runtime. The
scaffold provides:

1. A bootable HTTP server (`src/main.ts`) that:
   - Creates a Nest application using `@nestjs/platform-express`.
   - Listens on the port from the validated `PORT` env var.
   - Uses `nestjs-pino` as the application logger.
2. A typed, validated environment loader (`src/config/env.ts`) that:
   - Parses `process.env` against a zod schema.
   - Returns a typed `Env` object.
   - Throws and aborts the process if validation fails.
3. A logger module (`src/common/logger.ts`) that exports a Nest module wiring
   `nestjs-pino`, with redaction defaults that prevent secrets/tokens from
   leaking to stdout.
4. A `HealthModule` exposing `GET /health` returning `{ status: 'ok' }` with
   HTTP 200. No subsystem checks are wired yet — those land in later milestones.
5. A passing placeholder `bun test` test so CI has something to run.
6. Tooling files committed: `package.json`, `tsconfig.json`, `.gitignore`,
   `.env.example`.

## Constraints

- **Hexagonal architecture** (per `docs/swe-config.json`): the source root is
  `src/`. The scaffold's `HealthModule` is purely a framework adapter — it
  contains no domain code, so domain/infra separation is trivially satisfied.
  Future modules MUST keep domain free of NestJS imports.
- **No framework types in domain layer.** `Env` is plain TypeScript; it does
  not import from NestJS.
- **Validate all external input with zod at boundaries.** Env vars are external
  input and MUST be validated by `src/config/env.ts` at boot.
- **Use Bun primitives** where practical (test runner = `bun test`,
  `crypto.getRandomValues` over Node `crypto`, `fetch` over `node-fetch`).
- **Fail fast on bad config.** A malformed env aborts the process with a
  human-readable error before the HTTP server binds.
- **Logger redaction.** `nestjs-pino` MUST be configured with redaction paths
  for `authorization`, `cookie`, `set-cookie`, `req.headers.authorization`,
  `req.headers.cookie`, and any field name matching `password|token|secret|key`.
- **`.env.example` must mirror the configuration.md table.** All keys listed
  there are present, with empty or placeholder values.
- **Versioning rule:** `package.json` starts at version `0.1.0`.
- **Out of scope (deferred):** Appwrite, Redis, BullMQ, OAuth, LLM, Firecrawl,
  workers, digest graph, docker-compose. Env vars for these subsystems are
  declared in the schema but marked **optional** so the scaffold boots without
  them. Downstream milestones will tighten them to required as their features
  land.

## Acceptance criteria

- [ ] `bun install` succeeds with the committed `package.json` / `bun.lockb`.
- [ ] `bunx tsc --noEmit` passes with zero errors.
- [ ] `bun test` runs and passes with at least one placeholder test.
- [ ] `bun run start` (or equivalent script) boots the Nest app on `PORT` and
      logs a startup line via `nestjs-pino`.
- [ ] `curl http://localhost:$PORT/health` returns HTTP 200 with body
      `{"status":"ok"}`.
- [ ] Setting `PORT=not-a-number` causes the process to exit non-zero with a
      zod validation error before binding.
- [ ] `src/config/env.ts` exports a typed `Env` and a `loadEnv()` function;
      unit-tested for both happy path and validation failure.
- [ ] `src/common/logger.ts` exports a `LoggerModule` consumed by `AppModule`.
- [ ] `.env.example` is committed and lists every key documented in
      `docs/configuration.md`.
- [ ] `.gitignore` excludes `node_modules`, `dist`, `.env`, `.env.local`,
      `*.log`, `coverage/`, and editor files.
- [ ] `package.json` version is `0.1.0`.
