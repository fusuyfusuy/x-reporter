---
title: "X OAuth2 PKCE flow"
type: spec
tags: [auth, oauth, pkce, crypto, tokens, users, session]
created: 2026-04-06
updated: 2026-04-06
issue: 3
---

## Behavior

This milestone implements end-to-end sign-in with X (Twitter) using the
OAuth2 Authorization Code flow with PKCE. After this milestone the system
can: send a user to X to authorize, exchange the returned code for tokens,
encrypt those tokens at rest, persist a `users` row, issue a session cookie,
and (later, from background workers) refresh expired tokens transparently.

It introduces:

1. **`AuthModule`** (`src/auth/auth.module.ts`) wired into `AppModule`,
   exposing `AuthController` and providing `AuthService`, `XOAuthClient`,
   `UsersRepo`, `TokensRepo`, and the cookie/crypto helpers.

2. **`AuthController`** (`src/auth/auth.controller.ts`) with two endpoints:
   - `GET /auth/x/start` — generates a PKCE `code_verifier` and `state`,
     stores them in a signed short-lived cookie, and 302-redirects to the
     X authorize URL built from `X_CLIENT_ID`, `X_REDIRECT_URI`, and
     `X_SCOPES`.
   - `GET /auth/x/callback?code=...&state=...` — validates the state cookie
     (presence, signature, expiry, value match), exchanges the code for
     tokens via `XOAuthClient`, encrypts the tokens with AES-256-GCM,
     upserts the `users` row, persists the encrypted tokens to the `tokens`
     collection, clears the state cookie, sets a signed session cookie
     carrying the user id, and 302-redirects to `/me`.

3. **`AuthService`** (`src/auth/auth.service.ts`) — the orchestrator. It owns:
   - `startAuthorization()` — returns `{ authorizeUrl, stateCookie }`.
   - `handleCallback({ code, state, stateCookie })` — runs the full callback
     pipeline and returns `{ userId, sessionCookie }`.
   - `getValidAccessToken(userId)` — loads the tokens row, decrypts, and:
     - if `expiresAt - now > 60s` → returns the plaintext access token.
     - otherwise → calls `XOAuthClient.refresh(refreshToken)`, encrypts and
       persists the new pair, returns the new plaintext access token.
     - on refresh failure → calls `UsersRepo.setStatus(userId, 'auth_expired')`
       and throws a typed `AuthExpiredError`.

4. **`XOAuthClient`** port + adapter (`src/auth/x-oauth-client.ts`) — the
   only place in the auth module that touches X's HTTPS endpoints. Defines
   the interface:
   ```ts
   interface XOAuthClient {
     buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string;
     exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse>;
     refresh(refreshToken: string): Promise<XTokenResponse>;
   }
   ```
   The default impl (`HttpXOAuthClient`) wraps Bun's native `fetch` against
   `https://api.twitter.com/2/oauth2/token` (PKCE token endpoint). Tests
   inject a fake `fetch` (or a fake client) so no network is touched.

5. **PKCE helpers** (`src/auth/pkce.ts`) — pure functions:
   - `generateState()` → 32 random URL-safe bytes (base64url).
   - `generateCodeVerifier()` → 64 random URL-safe bytes (base64url, ≥ 43 chars).
   - `deriveCodeChallenge(verifier)` → `base64url(SHA-256(verifier))`.

6. **Crypto helpers** (`src/common/crypto.ts`) — pure functions:
   - `loadEncryptionKey(base64)` → `Uint8Array(32)` (validates length, throws otherwise).
   - `encrypt(plaintext, key)` → `string` formatted as `base64(iv):base64(ciphertext+tag)`
     where `iv` is a fresh random 12-byte nonce per call.
   - `decrypt(token, key)` → `string` plaintext. Throws on tamper (any mutation
     of iv or ciphertext+tag triggers a decryption failure).
   - Algorithm: AES-256-GCM via Node's `crypto` module (synchronous, no async
     boundary, available in Bun).

7. **Cookie helpers** (`src/auth/cookies.ts`):
   - `signCookieValue(payload, secret)` / `verifyCookieValue(raw, secret)` —
     HMAC-SHA256 over a JSON-stringified payload, base64url-encoded
     `payload.signature` format. Uses constant-time comparison.
   - `serializeCookie(name, value, opts)` and `parseCookies(header)` — minimal
     `Set-Cookie` and `Cookie` parsing so the auth module does not pull in a
     third-party cookie library.
   - State cookie: name `xr_oauth_state`, `httpOnly`, `sameSite=lax`,
     `secure` in production, `path=/auth/x`, `maxAge=600` (10 min).
   - Session cookie: name `xr_session`, `httpOnly`, `sameSite=lax`,
     `secure` in production, `path=/`, `maxAge=2592000` (30 days).

8. **`UsersRepo`** (`src/users/users.repo.ts`) — thin adapter over
   `AppwriteService.databases`:
   - `upsertByXUserId({ xUserId, handle })` — looks up the existing user by
     `xUserId`; if present returns it (resetting `status` to `active` if it
     was `auth_expired`); if absent creates a fresh row with
     `status: 'active'`, `createdAt: now`. Idempotent.
   - `setStatus(userId, status)` — updates `users.status` only.
   - `findById(userId)` and `findByXUserId(xUserId)` — convenience reads.
   - All methods return plain TypeScript shapes (`{ id, xUserId, handle, status, createdAt }`),
     never raw Appwrite document envelopes.

9. **`TokensRepo`** (`src/tokens/tokens.repo.ts`) — thin adapter over
   `AppwriteService.databases`:
   - `upsertForUser({ userId, accessToken, refreshToken, expiresAt, scope })` —
     ciphertext is the caller's responsibility; the repo never sees plaintext
     and never decrypts. If a row already exists for `userId` it is updated
     in place; otherwise it is created. Idempotent.
   - `findByUserId(userId)` — returns `{ accessToken, refreshToken, expiresAt, scope }`
     or `null`.
   - All methods return plain TypeScript shapes, never raw Appwrite envelopes.

10. **Env tightening** (`src/config/env.ts`):
    - `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `X_SCOPES`,
      `TOKEN_ENC_KEY`, and `SESSION_SECRET` move from `.optional()` to
      required.
    - `TOKEN_ENC_KEY` is validated as a base64 string that decodes to exactly
      32 bytes (the schema parses & re-encodes to enforce, with a clear
      error message).
    - `SESSION_SECRET` keeps its existing `min(32)` rule.
    - The schema's milestone comment is updated to mark issue #3 as
      tightened.

11. **`package.json` version** bumps from `0.2.0` to `0.3.0` (minor bump per
    the `versioning` rule in `swe-config.json`).

## Constraints

- **Hexagonal architecture (per `docs/swe-config.json`):**
  - `XOAuthClient` is a port interface; `HttpXOAuthClient` is the only
    adapter that imports `fetch` for X endpoints. `AuthService` consumes
    the interface, never calls `fetch` directly.
  - `UsersRepo` and `TokensRepo` are the only places (outside
    `AppwriteService` itself and the bootstrap script) that touch
    `appwrite.databases`. Their public methods accept and return plain
    TypeScript shapes — no `Models.Document<T>` envelopes leak.
  - No NestJS decorators on the port interface or on PKCE/crypto/cookie
    helper modules. Decorators only appear on the controller, the service,
    the repos (NestJS `@Injectable` is allowed there since they are
    framework-aware adapters), and the module file.

- **Crypto:** AES-256-GCM via Node's `crypto` module. Key is loaded once at
  boot from `TOKEN_ENC_KEY` (base64 → 32 raw bytes). Any other length
  aborts the process at boot. Each encryption uses a fresh random 12-byte
  IV. Stored format is `base64(iv) || ':' || base64(ciphertext+tag)` —
  matches `docs/configuration.md#token-encryption-at-rest` exactly.
  Decryption MUST throw on any tamper (changed iv, changed ciphertext,
  changed tag).

- **PKCE:** `code_verifier` is 64 bytes of random URL-safe base64 (well
  above the 43-char minimum from RFC 7636). `code_challenge` is
  `base64url(SHA-256(verifier))` and `code_challenge_method` is `S256`.
  Covered by a unit test that recomputes the challenge from a fixed
  verifier and asserts equality.

- **State cookie:** signed with HMAC-SHA256 using `SESSION_SECRET`. Carries
  `{ state, codeVerifier, createdAt }`. Rejected on `/callback` if missing,
  expired (> 10 minutes old), signature invalid, or its `state` field does
  not match the query-string `state`. The state cookie is cleared on the
  callback response regardless of success or failure.

- **Session cookie:** signed with HMAC-SHA256 using `SESSION_SECRET`.
  Carries `{ userId, issuedAt }`. Issued only after a successful callback.
  `httpOnly`, `sameSite=lax`, `secure` in production, `maxAge=2592000` (30
  days). The same signing helper as the state cookie.

- **getValidAccessToken refresh contract:**
  - Loads the tokens row via `TokensRepo`. If absent → throw
    `AuthExpiredError` (caller must redirect the user back through `/auth/x/start`).
  - If `expiresAt - now > 60_000ms` → return decrypted access token directly.
  - Otherwise → call `XOAuthClient.refresh(decryptedRefreshToken)`,
    re-encrypt the new access + refresh tokens, persist via
    `TokensRepo.upsertForUser`, return the new plaintext access token.
  - On refresh failure (any throw from `XOAuthClient.refresh`) → call
    `UsersRepo.setStatus(userId, 'auth_expired')` and throw
    `AuthExpiredError`. The original error message is wrapped, never logged
    with token contents.

- **No tokens or secrets in logs.** The logger redaction list already
  covers `accessToken`, `refreshToken`, `secret`, `token` — this milestone
  must not introduce any log line that would bypass redaction (no manual
  string interpolation of token values into log messages).

- **No third-party HTTP for X.** Bun's native `fetch` only. No `node-fetch`,
  no `axios`. The adapter sets `Content-Type: application/x-www-form-urlencoded`
  and a basic-auth Authorization header from `X_CLIENT_ID:X_CLIENT_SECRET`
  per the X OAuth2 confidential client docs.

- **Validate all external input with zod at boundaries.** The callback
  query string is parsed via a small zod schema before it reaches the
  service. The X token endpoint response is also parsed via zod so a
  malformed X response cannot poison persistence.

- **Out of scope (deferred):**
  - The actual `/me` controller — owned by issue #4. The redirect target
    must exist as a route, but `/me` returning 404 from this PR is fine
    because `#4` will land before any user-facing release.
  - Logout / token revocation.
  - Multi-account support.
  - Envelope encryption / `TOKEN_ENC_KEY` rotation (explicitly deferred per
    `docs/configuration.md`).
  - Rate limiting on the auth endpoints.
  - BullMQ job registration on successful callback (issue #5).
  - Calling X v2 ingestion endpoints (`XSource` is owned by #6, and is a
    different port from `XOAuthClient`).

## Acceptance criteria

- [ ] `src/common/crypto.ts` exports `loadEncryptionKey`, `encrypt`, and
      `decrypt`. Unit tests cover: round-trip; key length validation
      (rejects ≠ 32 bytes); tamper detection (mutating any byte of the
      ciphertext+tag throws); IV uniqueness across calls.
- [ ] `src/auth/pkce.ts` exports `generateState`, `generateCodeVerifier`,
      and `deriveCodeChallenge`. Unit test recomputes the challenge from a
      fixed verifier and asserts equality with a known SHA-256 hash; also
      asserts generated values are URL-safe and meet the minimum lengths.
- [ ] `src/auth/cookies.ts` exports `signCookieValue`, `verifyCookieValue`,
      `serializeCookie`, and `parseCookies`. Unit tests cover: round-trip
      sign/verify; tamper rejection; expiry check; cookie header parsing
      with multiple cookies.
- [ ] `src/auth/x-oauth-client.ts` defines an `XOAuthClient` interface and
      exports `HttpXOAuthClient` plus a zod schema for the token-endpoint
      response. Unit tests inject a fake fetch and assert: authorize URL
      contains `client_id`, `redirect_uri`, `scope`, `state`,
      `code_challenge`, `code_challenge_method=S256`; `exchangeCode` posts
      form-encoded body with `grant_type=authorization_code`, `code`,
      `code_verifier`, `redirect_uri`, `client_id`, and basic-auth header;
      `refresh` posts `grant_type=refresh_token`, `refresh_token`,
      `client_id`, and basic-auth header; non-2xx response throws.
- [ ] `src/users/users.repo.ts` exposes `upsertByXUserId`, `setStatus`,
      `findById`, `findByXUserId`. Unit tests against a fake
      `AppwriteService`-shaped object cover upsert idempotency (same
      `xUserId` twice returns the same id), `auth_expired → active`
      transition on re-sign-in, and `setStatus` updating only the status.
- [ ] `src/tokens/tokens.repo.ts` exposes `upsertForUser` and
      `findByUserId`. Unit tests cover create-then-update idempotency,
      round-trip via the fake AppwriteService and the real crypto helpers,
      and `findByUserId` returning `null` for an unknown user.
- [ ] `src/auth/auth.service.ts` exposes `startAuthorization`,
      `handleCallback`, `getValidAccessToken`. Unit tests cover:
      - `getValidAccessToken` returns the existing token when not near
        expiry.
      - `getValidAccessToken` calls `XOAuthClient.refresh` when the token
        is within the 60s skew window, persists the new pair, and returns
        the new access token.
      - `getValidAccessToken` sets `users.status='auth_expired'` and
        throws `AuthExpiredError` when refresh fails.
      - `handleCallback` rejects mismatched state.
      - `handleCallback` rejects expired state cookie.
      - `handleCallback` upserts the user and persists encrypted tokens
        on the happy path.
- [ ] `src/auth/auth.controller.ts` exposes `GET /auth/x/start` and
      `GET /auth/x/callback`. The start endpoint returns 302 with a
      `Set-Cookie` for `xr_oauth_state` and a `Location` to the X
      authorize URL. The callback endpoint returns 302 to `/me` with a
      `Set-Cookie` for `xr_session` (and a clearing `Set-Cookie` for
      `xr_oauth_state`).
- [ ] `src/auth/auth.module.ts` registers the controller, service, port,
      adapter, repos, and helpers. `AppModule` imports it via
      `AuthModule.forRoot(env)` so the env-derived crypto key and cookie
      secret are passed in once.
- [ ] `src/config/env.ts`: `X_CLIENT_ID`, `X_CLIENT_SECRET`,
      `X_REDIRECT_URI`, `X_SCOPES`, `TOKEN_ENC_KEY`, and `SESSION_SECRET`
      are required. `TOKEN_ENC_KEY` is rejected unless it base64-decodes
      to exactly 32 bytes. `src/config/env.test.ts` has tests for each
      newly required var (omitted → throws) plus the key-length rule.
- [ ] `src/common/logger.test.ts` and `src/app.module.test.ts` are updated
      to set the new required vars so they keep passing.
- [ ] `package.json` version is `0.3.0`.
- [ ] `bun test`, `bunx tsc --noEmit`, and `bunx biome lint .` are all
      green.
