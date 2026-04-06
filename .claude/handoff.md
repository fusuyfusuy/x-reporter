---
trigger: "GitHub issue #3 — feat(auth): X OAuth2 PKCE flow. Implement /auth/x/start and /auth/x/callback with PKCE, AES-256-GCM token encryption, encrypted persistence to the tokens collection, user upsert, session cookie, AuthService.getValidAccessToken with transparent refresh, and auth_expired handling."
type: feat
branch: feat/x-oauth
base-branch: main
created: 2026-04-06
version-bump: minor
---

## Related Files
Existing files to touch:
- src/config/env.ts — tighten X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI, X_SCOPES, TOKEN_ENC_KEY, SESSION_SECRET from optional to required
- src/config/env.test.ts — add tests for the newly required vars
- src/app.module.ts — register AuthModule, UsersModule (or whatever holds the upsert), TokensModule
- src/common/logger.test.ts — update test env to include the new required vars
- src/app.module.test.ts — same env update for the e2e-lite test

New files to create:
- src/common/crypto.ts — AES-256-GCM encrypt/decrypt helpers, key loaded from TOKEN_ENC_KEY (base64 → 32 raw bytes at boot)
- src/common/crypto.test.ts — round-trip + tamper detection + key length validation
- src/auth/auth.module.ts
- src/auth/auth.controller.ts — GET /auth/x/start, GET /auth/x/callback
- src/auth/auth.service.ts — orchestrates PKCE, code exchange, refresh, user/token persistence
- src/auth/auth.service.test.ts — refresh logic, auth_expired transition
- src/auth/pkce.ts — generates state + code_verifier + code_challenge (S256)
- src/auth/pkce.test.ts — generation + verifier→challenge correctness
- src/auth/x-oauth-client.ts — port interface + node-fetch adapter for X token endpoint (authorize URL builder, code exchange, refresh)
- src/auth/x-oauth-client.test.ts — adapter unit tests with a fake fetch
- src/auth/cookies.ts — signed short-lived cookie helpers for the PKCE state and the session cookie
- src/users/users.repo.ts — upsertByXUserId, setStatus helpers backed by AppwriteService
- src/users/users.repo.test.ts — upsert idempotency and status transitions against a fake AppwriteService
- src/tokens/tokens.repo.ts — save/get/update encrypted tokens, FK by userId
- src/tokens/tokens.repo.test.ts — round-trip via fake AppwriteService + crypto
- docs/specs/x-oauth.md — milestone spec (per autoDocs directive)

## Relevant Docs
- docs/api.md#auth — /auth/x/start (302 to authorize URL) and /auth/x/callback (validates state, exchanges code, persists encrypted tokens, 302 to /me) contracts
- docs/configuration.md#token-encryption-at-rest — AES-256-GCM details: 32-byte key from TOKEN_ENC_KEY, base64-decoded at boot, no rotation in v1
- docs/data-model.md — users (upserted on first sign-in) and tokens (FK userId unique, accessToken/refreshToken as ciphertext, expiresAt, scope) collections, already bootstrapped in #2
- docs/architecture.md — module layout
- docs/interfaces.md — X is wrapped behind XSource for ingestion (#6); the OAuth client here is a different port — wrap it behind an interface so the X token endpoint can be faked in tests
- docs/swe-config.json — hexagonal: no node-fetch / X SDK leakage outside the adapter; AppwriteService is the only persistence boundary
- docs/implementation-plan.md#3 — milestone #3 acceptance criteria

## Related Issues
- #3 feat(auth): X OAuth2 PKCE flow (open) — this issue
- #1 (merged) — Bun + Nest scaffold + zod env loader
- #2 (merged) — AppwriteService + users/tokens collections already exist in the schema
- #4 — /me endpoints depend on the session cookie issued here
- #6, #7 — workers will call AuthService.getValidAccessToken

## Scope
Implement the full X OAuth2 PKCE sign-in flow end-to-end, including encrypted token persistence and a transparent refresh helper that the rest of the system will rely on.

**Acceptance criteria (from issue #3):**
- [ ] GET /auth/x/start generates state + code_verifier, stores them in a signed short-lived cookie, redirects to X authorize URL
- [ ] GET /auth/x/callback validates state, exchanges code for tokens, encrypts with AES-256-GCM, persists to tokens
- [ ] users row upserted on first sign-in
- [ ] Session cookie issued on success; 302 to /me
- [ ] AuthService.getValidAccessToken(userId) refreshes the token transparently if expired
- [ ] Refresh failure marks user.status = 'auth_expired'
- [ ] Unit tests for crypto.ts (encrypt/decrypt round-trip) and PKCE generation

**Out of scope (deferred):**
- /me endpoints (#4) — only ensure the 302 target exists; the controller for /me is #4
- Rate limiting on auth endpoints
- Multi-account / account switching
- Envelope encryption / TOKEN_ENC_KEY rotation (explicitly deferred per docs/configuration.md)
- Logging out / token revocation
- Actually calling X v2 ingestion endpoints (#6 owns XSource)

**Architecture / implementation notes:**
- **Hexagonal:** wrap the X token endpoint behind an `XOAuthClient` port interface in `src/auth/x-oauth-client.ts`. The adapter uses Bun's native fetch. AuthService consumes the port, never raw fetch.
- **Crypto:** AES-256-GCM via Bun's `crypto.subtle` or Node's `crypto`. Key is `TOKEN_ENC_KEY` base64-decoded once at boot — fail loud if not exactly 32 bytes. Store IV + ciphertext + tag together in a single base64 blob (e.g., `iv:ciphertext:tag` or a single concatenated buffer). Cover with a round-trip test AND a tamper-detection test (mutated ciphertext must throw).
- **PKCE:** code_verifier 64+ random URL-safe chars, code_challenge = base64url(SHA-256(verifier)), challenge_method=S256. Cover with a unit test that recomputes the challenge from the verifier and asserts equality.
- **State cookie:** signed (HMAC with SESSION_SECRET) short-lived cookie carrying { state, code_verifier, createdAt }. httpOnly, sameSite=lax, secure in production, max-age 10 min. Reject on /callback if missing, expired, or signature mismatch.
- **Session cookie:** issued after successful callback. Carries `userId` (signed). httpOnly, sameSite=lax, secure in production, longer max-age. Same signing helper as the state cookie.
- **getValidAccessToken:** loads the tokens row, decrypts, checks expiresAt with a small skew (e.g., 60s). If still valid → return. If expired → call XOAuthClient.refresh(refreshToken). On success: encrypt + persist new tokens, return new access token. On failure: set user.status = 'auth_expired' via UsersRepo, then throw a typed AuthExpiredError.
- **Env:** `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `X_SCOPES`, `TOKEN_ENC_KEY`, `SESSION_SECRET` move from optional → required in `src/config/env.ts`. Existing tests in env.test.ts and logger.test.ts and app.module.test.ts must be updated to provide values for these so they keep passing.
- **Repos:** UsersRepo and TokensRepo are thin adapters over AppwriteService. They expose plain TypeScript shapes (no Appwrite SDK types in their public surface). They live alongside auth because they're the first consumers — later milestones can move them.
- **Versioning:** bump package.json minor: 0.2.0 → 0.3.0.
- **Quality gate:** `bun test`, `bunx tsc --noEmit`, `bunx biome lint .` must all be green.
