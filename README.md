# x-reporter

Per-user X (Twitter) likes/bookmarks digest service. On a per-user schedule,
x-reporter pulls a user's likes and bookmarks, extracts URLs/articles
referenced in them, fetches and cleans the article content, then uses an LLM
(orchestrated via LangGraph) to produce a personalized digest. Digests are
persisted in Appwrite and exposed via REST.

Runtime: Bun. Framework: NestJS. Queue: BullMQ + Redis. Storage: Appwrite.

## Quickstart

```sh
# 1. Clone
git clone https://github.com/fusuyfusuy/x-reporter.git
cd x-reporter

# 2. Install deps
bun install

# 3. Configure env
cp .env.example .env
# Fill in: APPWRITE_*, X_CLIENT_ID/SECRET, OPENROUTER_API_KEY,
#          FIRECRAWL_API_KEY, TOKEN_ENC_KEY, SESSION_SECRET.
# See docs/configuration.md for how to generate the crypto material.

# 4. Bring up Redis
docker compose up -d

# 5. Bootstrap Appwrite collections, then run the dev server
bun run setup:appwrite
bun run start:dev
```

Visit `http://localhost:3000/auth/x/start` to begin the OAuth flow.

> Appwrite is not included in the compose file because its stack is large
> and evolves independently. Point `APPWRITE_ENDPOINT` at
> [Appwrite Cloud](https://cloud.appwrite.io/v1), or self-host per the
> [official instructions](https://appwrite.io/docs/advanced/self-hosting).

## Scripts

| Script                    | What it does                                  |
|---------------------------|-----------------------------------------------|
| `bun run start`           | Run the API + workers                         |
| `bun run start:dev`       | Run with `--watch` for local dev              |
| `bun run build`           | Bundle to `dist/` with Bun's bundler          |
| `bun test`                | Run unit + e2e tests                          |
| `bun run lint`            | Biome lint                                    |
| `bun run format`          | Biome format (write)                          |
| `bun run typecheck`       | `tsc --noEmit`                                |
| `bun run setup:appwrite`  | Create Appwrite database + collections        |

## Project structure

- `src/` — NestJS application (modules per domain: `auth`, `ingestion`, `extraction`, `digest`, `queue`, `schedule`, `tokens`, `users`, `digests`, `workers`, `appwrite`, `health`, `common`, `config`)
- `scripts/` — one-off operational scripts (`setup-appwrite.ts`)
- `docs/` — architecture, data model, API, jobs, LLM graph, interfaces, configuration
- `docker-compose.yml` — local Redis for BullMQ
- `.env.example` — every env var the app reads, grouped by section

## Docs

- [docs/configuration.md](./docs/configuration.md) — env vars, secrets, local dev
- [docs/architecture.md](./docs/architecture.md) — stack, modules, data flow
- [docs/api.md](./docs/api.md) — REST surface, auth flow, payload shapes
- [docs/jobs.md](./docs/jobs.md) — BullMQ queues, job payloads, retry policy
- [docs/data-model.md](./docs/data-model.md) — Appwrite collections, fields, indexes
- [docs/llm-and-graph.md](./docs/llm-and-graph.md) — LangGraph nodes + prompts
- [docs/interfaces.md](./docs/interfaces.md) — `XSource` / `ArticleExtractor` / `LlmProvider` swap-points
- [docs/README.md](./docs/README.md) — docs index
