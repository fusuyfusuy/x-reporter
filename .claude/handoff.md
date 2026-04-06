---
trigger: "GitHub issue #2 — feat(appwrite): SDK wrapper + collection bootstrap. Add AppwriteModule + AppwriteService wrapping node-appwrite with typed helpers, idempotent scripts/setup-appwrite.ts that creates database/collections/attributes/indexes from docs/data-model.md, and extend GET /health to also ping Appwrite."
type: feat
branch: feat/appwrite-bootstrap
base-branch: main
created: 2026-04-06
version-bump: minor
---

## Related Files
- src/health/health.controller.ts — extend with Appwrite ping
- src/health/health.module.ts — wire AppwriteModule
- src/app.module.ts — register AppwriteModule
- src/config/env.ts — tighten APPWRITE_* vars from optional → required
- .env.example — already has Appwrite vars (no change expected)

New files to create:
- src/appwrite/appwrite.module.ts
- src/appwrite/appwrite.service.ts
- src/appwrite/appwrite.service.test.ts
- scripts/setup-appwrite.ts

## Relevant Docs
- docs/data-model.md — authoritative schema for 5 collections (users, tokens, items, articles, digests) with fields and indexes
- docs/configuration.md — APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID env vars
- docs/architecture.md — module layout and persistence positioning
- docs/swe-config.json — hexagonal: no Appwrite SDK types in domain layer; wrap behind port-shaped interface
- docs/implementation-plan.md#2 — milestone #2 acceptance criteria

## Related Issues
- #2 feat(appwrite): SDK wrapper + collection bootstrap (open) — this issue
- #1 (merged) — provides the Bun + NestJS + zod env scaffold
- #3, #4, #5, #6, #7, #8, #11 — all consume the persistence layer added here

## Scope
Build the Appwrite persistence foundation: a Nest module + service that wraps `node-appwrite` with typed helpers, plus an idempotent bootstrap script that materializes the full schema in a fresh Appwrite project.

**Acceptance criteria (from issue #2):**
- [ ] `AppwriteModule` + `AppwriteService` wrap `node-appwrite` with typed helpers
- [ ] `scripts/setup-appwrite.ts` is idempotent and creates database, all collections, attributes, and indexes from `docs/data-model.md`
- [ ] Re-running the script after a clean run is a no-op (no errors, no duplicate indexes)
- [ ] `/health` now also pings Appwrite

**Schema to materialize (from docs/data-model.md):**
- Database id: `xreporter`
- Collections: `users`, `tokens`, `items`, `articles`, `digests`
- All fields, types, and indexes per the doc tables
- Compound + unique indexes (e.g., `users.xUserId` unique, `items.userId+xTweetId` unique)

**Out of scope (deferred):**
- Token encryption helpers (#3 owns AES-GCM crypto)
- OAuth flows (#3)
- Any data writes to collections beyond what the bootstrap script needs
- Migration tooling beyond idempotency (rotation, downgrades, etc.)

**Architecture notes:**
- Hexagonal: Appwrite SDK types must NOT leak into domain code. `AppwriteService` is the adapter; downstream feature modules consume it through typed helpers, not raw SDK objects.
- `APPWRITE_*` env vars currently optional in `src/config/env.ts` — tighten to required as part of this issue.
- `/health` Appwrite ping should be a lightweight call (e.g., `databases.get(databaseId)`) wrapped in a try/catch returning `{ appwrite: 'ok' | 'down' }`.
- Idempotency strategy for setup script: list existing collections/attributes/indexes and create only what's missing. Treat 409 (already exists) as success.
- Bump `package.json` minor: `0.1.0` → `0.2.0`.
