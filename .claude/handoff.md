---
trigger: "GitHub issue #6 — feat(ingestion): XSource interface + X API v2 impl. Define XSource port interface per docs/interfaces.md, implement XApiV2Source against X API v2 (fetchLikes + fetchBookmarks with cursor handling), implement url-extractor.ts that pulls URLs from entities.urls falling back to text regex with t.co stripping and dedup. Unit tests for url-extractor. No processor wiring (that's #7)."
type: feat
branch: feat/x-source
base-branch: main
created: 2026-04-07
version-bump: minor
---

## Related Files
Existing files to touch:
- docs/interfaces.md — XSource interface already specified; re-export/reference from the new port file, no changes needed unless there are minor clarifications
- src/auth/auth.service.ts — XApiV2Source calls getValidAccessToken(userId); AuthService already exists and is exported
- src/app.module.ts — register IngestionModule

New files to create:
- src/ingestion/x-source.port.ts — TypeScript port interface: FetchPage { items: TweetItem[]; nextCursor?: string }, TweetItem { tweetId, text, authorHandle, urls, kind }, XSource { fetchLikes, fetchBookmarks }
- src/ingestion/x-api-v2.source.ts — XApiV2Source adapter. Uses Bun native fetch against X API v2 endpoints (GET /2/users/:id/liked_tweets, GET /2/users/:id/bookmarks). Gets a valid access token per call via AuthService.getValidAccessToken(userId). Parses the X v2 response shape with zod. Passes each raw tweet through url-extractor to populate urls[].
- src/ingestion/x-api-v2.source.test.ts — unit tests with a fake fetch + fake AuthService. Cover happy path, cursor pass-through, pagination, auth-expired propagation, malformed X response (zod error path).
- src/ingestion/url-extractor.ts — pure function extractUrls(tweet: { text: string; entities?: { urls?: Array<{ expanded_url: string }> } }): string[]. Logic: (1) if entities.urls is present and non-empty, map to expanded_url and skip regex; (2) else regex-scan text for URLs. In both cases: strip t.co wrappers (any URL matching /https?:\/\/t\.co\//), dedup (lowercase), return sorted for determinism.
- src/ingestion/url-extractor.test.ts — pure unit tests covering: no URLs, text-only URLs, entities.urls present (takes precedence), mixed, multiple URLs, dedup, t.co stripping, entities.urls with t.co links filtered out.
- src/ingestion/ingestion.module.ts — NestJS module that provides XApiV2Source under the X_SOURCE DI token, and exports it as XSource for downstream consumers (#7 poll-x processor). AuthModule must be imported (for AuthService injection).
- docs/specs/x-source.md — milestone spec (per autoDocs directive)

## Relevant Docs
- docs/interfaces.md#1-xsource — authoritative FetchPage / XSource interface definition (already specified in detail: fetchLikes, fetchBookmarks, cursor parameter, FetchPage shape)
- docs/interfaces.md#4-xoauthclient — XOAuthClient is a separate port for the token endpoint (auth module); XApiV2Source uses AuthService, not XOAuthClient directly
- docs/architecture.md — ingestion module placement
- docs/data-model.md — items collection shape (items land in Appwrite in #7; this milestone only constructs the in-memory representation)
- docs/swe-config.json — hexagonal: X API fetch must not leak past src/ingestion/; AuthService is fine to import (it's an application service, not infrastructure)
- docs/implementation-plan.md#6 — milestone #6 acceptance criteria

## Related Issues
- #6 feat(ingestion): XSource interface + X API v2 impl (open) — this issue
- #3 (merged) — AuthService.getValidAccessToken used by XApiV2Source
- #4 (merged) — users repo + cadence; userId comes from users established in auth
- #5 (open, in progress) — BullMQ queues; XSource is consumed by the poll-x processor in #7 but not here
- #7 (open) — poll-x processor wires XSource into the queue pipeline

## Scope
Implement the XSource ingestion port and X API v2 adapter so the poll-x processor (#7) has a clean, testable data source to call.

**Acceptance criteria (from issue #6):**
- [ ] XSource interface defined per docs/interfaces.md
- [ ] XApiV2Source implements fetchLikes and fetchBookmarks against X API v2 using AuthService for tokens
- [ ] url-extractor.ts pulls expanded URLs from entities.urls and falls back to text regex; t.co stripped to canonical
- [ ] Cursor handling: returns nextCursor for downstream callers
- [ ] Unit tests for url-extractor covering: pure-text URLs, multiple URLs, entities.urls precedence, dedup
- [ ] No processor wiring yet (#7)

**Out of scope (deferred):**
- Writing items to Appwrite (#7)
- Rate limiting / retry at the HTTP level (BullMQ retry handles it in #7)
- Tweet media / poll expansion beyond text + URLs
- Bookmark write-back or deletion

**Architecture / implementation notes:**
- **Port definition:** XSource interface in `src/ingestion/x-source.port.ts`. TweetItem shape: { tweetId: string; text: string; authorHandle: string; urls: string[]; kind: 'like' | 'bookmark' }. FetchPage: { items: TweetItem[]; nextCursor?: string }. Matches docs/interfaces.md exactly.
- **X API v2 endpoints:**
  - Likes: GET /2/users/:xUserId/liked_tweets?tweet.fields=entities,author_id,text&user.fields=username&max_results=100&pagination_token=<cursor>
  - Bookmarks: GET /2/users/:xUserId/bookmarks?tweet.fields=entities,author_id,text&user.fields=username&max_results=100&pagination_token=<cursor>
  - Both require OAuth2 Bearer token (user context, not app-only). Pass as Authorization: Bearer <accessToken>.
  - Response shape: { data: Array<{id, text, author_id, entities?: {urls?:[{expanded_url,url}]}}>, meta: { next_token?: string }, includes?: { users: [{id, username}] } }
- **Author handle resolution:** X v2 liked_tweets/bookmarks puts author data in `includes.users`. Match tweet.author_id → includes.users[n].id → username. If missing, fall back to empty string (tests must cover this).
- **getValidAccessToken:** requires the internal Appwrite user id (users.$id), NOT the xUserId. AuthService.getValidAccessToken signature is getValidAccessToken(userId: string) where userId is the Appwrite document id. The adapter must receive the Appwrite userId from callers (the poll-x processor in #7 will pass it).
- **zod parsing:** define a strict zod schema for the X v2 response. Unknown fields are fine (passthrough on the outer wrapper), but the fields we depend on (id, text) must be present. Parse errors → throw with a descriptive message (let BullMQ retry in #7).
- **url-extractor:** pure function (no NestJS). extractUrls takes the raw tweet object (text + optional entities.urls). Returns string[]. t.co detection: filter any URL where the expanded_url hostname is t.co OR the original URL (url field) hostname is t.co and there's no better expansion. Dedup by lowercased URL, sort alphabetically for determinism in tests.
- **DI token:** export X_SOURCE = 'XSource' from ingestion.module.ts so #7 can inject by token without importing XApiV2Source directly.
- **Versioning:** bump package.json minor: 0.4.0 → 0.5.0. NOTE: #5 is also bumping 0.4.0 → 0.5.0. Whichever merges second will need to bump 0.5.0 → 0.6.0. The run-finish skill handles this — the version staleness check will catch it and the bump commit will be applied before merge.
- **Quality gate:** bun test, bunx tsc --noEmit, bunx biome lint . must all be green.
