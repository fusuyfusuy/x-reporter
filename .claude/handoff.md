---
trigger: "GitHub issue #1 — chore: scaffold Bun + NestJS project. Lay down the project skeleton: bun init, NestJS with @nestjs/platform-express, src/main.ts boots on PORT, src/config/env.ts validates env via zod, src/common/logger.ts wires nestjs-pino, GET /health returns {status:'ok'}, bun test passes a placeholder, tsconfig/.gitignore/.env.example committed."
type: feat
branch: feat/scaffold-nest
base-branch: main
created: 2026-04-06
version-bump: minor
---

## Related Files
None — greenfield. Only `docs/` and `docs/swe-config.json` exist in the repo.

## Relevant Docs
- docs/architecture.md — full stack, module layout, data flow
- docs/configuration.md — env vars, zod validation, local dev quickstart, .env.example contents
- docs/implementation-plan.md — milestone #1 acceptance criteria
- docs/swe-config.json — stack: Bun + TypeScript, biome lint/format, tsc typecheck, hexagonal architecture rules

## Related Issues
- #1 chore: scaffold Bun + NestJS project (open) — this issue
- #2–#13 (open) — all downstream milestones depend on this scaffold

## Scope
Bootstrap the x-reporter project skeleton so all subsequent milestones have a working Bun + NestJS foundation to build on.

**Acceptance criteria (from issue #1):**
- [ ] `bun init` complete; `package.json` configured for Bun + Nest
- [ ] NestJS installed with `@nestjs/platform-express`
- [ ] `src/main.ts` boots a Nest app on `PORT`
- [ ] `src/config/env.ts` validates env via zod, fails fast on bad config
- [ ] `src/common/logger.ts` wires `nestjs-pino`
- [ ] `GET /health` returns `{ status: 'ok' }` (subsystem checks added in later issues)
- [ ] `bun test` runs and passes a placeholder test
- [ ] `tsconfig.json`, `.gitignore`, `.env.example` committed

**Out of scope (deferred to later issues):**
- Appwrite wiring (#2)
- OAuth (#3), /me endpoints (#4), queues (#5), ingestion (#6+), workers, digest graph
- Subsystem health checks (Redis/Appwrite pings) — only stub `{status:'ok'}` for now
- docker-compose (#13)

**Architecture notes:**
- Hexagonal: domain code must not import infrastructure; ports/adapters separation enforced per `docs/swe-config.json`
- Validate all external input with zod at boundaries
- Use Bun's native crypto/fetch over Node polyfills where possible
- Lint: `bunx biome lint .` / Format: `bunx biome format --write .` / Typecheck: `bunx tsc --noEmit` / Test: `bun test`
- Bump `package.json` version in the same PR (versioning rule). Since this PR creates `package.json`, set initial version to `0.1.0`.
