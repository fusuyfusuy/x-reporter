# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

x-reporter is a multi-user service that polls a user's X (Twitter) likes/bookmarks, extracts linked articles, and builds AI-generated digests. Stack: **Bun + NestJS + Appwrite + BullMQ/Redis + LangGraph + OpenRouter**.

## Commands

```bash
bun run start:dev          # dev server with watch
bun run start              # production start
bun run build              # bundle to dist/
bun test                   # run all tests
bun test src/path/file.test.ts  # single test file
bunx biome lint .          # lint
bunx biome format --write .  # format
bunx tsc --noEmit          # typecheck
bun run setup:appwrite     # bootstrap Appwrite collections
```

## Architecture

Hexagonal (ports & adapters) with NestJS DI. Three swap-point interfaces: **XSource**, **ArticleExtractor**, **LlmProvider** (defined as ports — see `docs/interfaces.md`).

### Module Dependency Order

`LoggerModule → AppwriteModule → QueueModule → UsersRepoModule (global) → ScheduleModule (global) → feature modules (Auth, Users, Ingestion, Workers, Health)`

All modules use a static `.forRoot(env: Env)` factory receiving the validated env config.

### Key Rules

- **Domain layer never imports infrastructure.** No BullMQ types, Appwrite SDK types, or NestJS decorators in domain code.
- **BullMQ + ioredis types confined to `src/queue/`, `src/schedule/`, and `src/workers/`** — everything else uses string DI tokens.
- **Repos return plain TypeScript shapes**, never Appwrite `Models.Document<T>` envelopes.
- **All external I/O goes through a port interface** — never call X API, Firecrawl, OpenRouter, or Appwrite directly from domain code.
- **Long-running work belongs in BullMQ processors**, never on the HTTP request path.
- **Validate external input with zod** at HTTP and queue boundaries.
- **Prefer Bun-native crypto and fetch** over Node polyfills.

### Config & Secrets

- Env validated at boot via zod schema in `src/config/env.ts` — `loadEnv()` runs before `NestFactory.create`.
- Token encryption: AES-256-GCM via `TOKEN_ENC_KEY` (base64-encoded 32 bytes).
- Path alias: `~/*` maps to `./src/*`.

### Data (Appwrite)

Collections: `users`, `tokens`, `items`, `articles`, `digests`. Schema details in `docs/data-model.md`. When changing schema, update both `docs/data-model.md` and `scripts/setup-appwrite.ts` in the same PR.

## Delivery Conventions

- **Conventional Commits** for PR titles: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- **Branch names**: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`
- One milestone issue = one branch = one PR. Don't bundle milestones.
- Bump `package.json` version in the same PR as the change.
- PR body must include an acceptance-criteria checklist mirroring the linked issue.
- When adding a port or adapter, update `docs/interfaces.md` in the same PR.
- Keep `docs/` as source of truth — update relevant docs alongside code changes.

## Formatting (Biome)

- 100-column line width, 2-space indent, single quotes, trailing commas.
