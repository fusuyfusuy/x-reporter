# x-reporter docs

x-reporter is a backend service that, on a per-user schedule, pulls a user's
X (Twitter) likes and bookmarks, extracts URLs/articles referenced in them,
fetches and cleans the article content, then uses an LLM (orchestrated via
LangGraph) to produce a personalized digest. Digests are persisted in
Appwrite and exposed via REST.

## Index

- [architecture.md](./architecture.md) — stack, modules, data flow, diagram
- [data-model.md](./data-model.md) — Appwrite collections, fields, indexes
- [api.md](./api.md) — REST surface, auth flow, payload shapes
- [jobs.md](./jobs.md) — BullMQ queues, job payloads, retry policy
- [llm-and-graph.md](./llm-and-graph.md) — LangGraph state machine, nodes, prompts
- [interfaces.md](./interfaces.md) — `XSource`, `ArticleExtractor`, `LlmProvider` swap-points
- [configuration.md](./configuration.md) — env vars, secrets, local dev setup
- [implementation-plan.md](./implementation-plan.md) — milestone-by-milestone build order

## Tech stack at a glance

| Layer        | Choice                                                  |
|--------------|---------------------------------------------------------|
| Runtime      | Bun                                                     |
| Framework    | NestJS (`@nestjs/platform-express`)                     |
| DB           | Appwrite                                                |
| Queue        | BullMQ + Redis                                          |
| AI orch.     | LangChain + LangGraph (`@langchain/langgraph`)          |
| LLM (default)| OpenRouter (swappable)                                  |
| Extractor    | Firecrawl (swappable)                                   |
| X source     | X API v2 OAuth2 user context (swappable)                |

## Design pillars

1. **Multi-user from day one** — every user has their own X OAuth2 tokens, cadence, and digests.
2. **Three swap-points** — `XSource`, `ArticleExtractor`, `LlmProvider` are interfaces. The default impls can be replaced without touching the rest of the system.
3. **Scheduled, queue-driven** — all polling, extraction, and digest generation runs through BullMQ repeatable jobs. The HTTP layer never blocks on external work.
4. **Stored-only output (v1)** — no email, no UI. Digests live in Appwrite and are read via REST.
