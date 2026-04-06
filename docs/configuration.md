# Configuration & local dev

## Environment variables

All env vars are validated by `src/config/env.ts` (zod). The process exits at
boot if any required var is missing or malformed.

```
# Appwrite
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=
APPWRITE_API_KEY=
APPWRITE_DATABASE_ID=xreporter

# Redis (BullMQ)
REDIS_URL=redis://localhost:6379

# X OAuth2
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REDIRECT_URI=http://localhost:3000/auth/x/callback
X_SCOPES=tweet.read users.read like.read bookmark.read offline.access

# LLM (default: openrouter)
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5

# Article extractor (default: firecrawl)
EXTRACTOR=firecrawl
FIRECRAWL_API_KEY=

# Crypto / sessions
TOKEN_ENC_KEY=         # 32 bytes, base64. Used for AES-256-GCM token encryption.
SESSION_SECRET=        # >= 32 chars. Signs the session cookie.

# Worker concurrency (optional, defaults shown)
POLL_X_CONCURRENCY=5
EXTRACT_ITEM_CONCURRENCY=10
BUILD_DIGEST_CONCURRENCY=2

# Server
PORT=3000
NODE_ENV=development
```

### Generating crypto material

```sh
# 32-byte AES key, base64-encoded
bun -e "console.log(crypto.getRandomValues(new Uint8Array(32)).toBase64())"

# 48-char session secret
bun -e "console.log(crypto.getRandomValues(new Uint8Array(36)).toBase64())"
```

## Token encryption at rest

X access and refresh tokens are encrypted with AES-256-GCM before being
written to Appwrite:

- Key: `TOKEN_ENC_KEY` (32 raw bytes, base64-decoded at boot).
- Per-record: random 12-byte IV.
- Stored format: `base64(iv) || ':' || base64(ciphertext+tag)`.
- Decryption only happens inside `AuthService`. No other module sees plaintext tokens.

Rotating `TOKEN_ENC_KEY` is **not** supported in v1 — rotation would force
every user to re-auth. A future issue will add envelope encryption.

## Secrets handling

- Local dev: `.env` (gitignored). `bun --env-file=.env run start:dev`.
- Server: env vars injected by the systemd unit / process supervisor. Per
  the project CLAUDE.md, secrets live under `~/.config/secrets/` (chmod 600)
  and are sourced into the unit's environment, never copied into the repo.

## Local dev quickstart

```sh
# 1. Bring up Redis + Appwrite
docker compose up -d redis appwrite

# 2. Install deps
bun install

# 3. Bootstrap Appwrite collections
bun run scripts/setup-appwrite.ts

# 4. Run the API + workers in dev mode
bun run start:dev
```

Visit `http://localhost:3000/auth/x/start` to begin the OAuth flow.

## Tests

```sh
bun test                          # all unit + e2e
bun test src/ingestion            # one module
bun test src/digest/graph         # graph nodes with stub LLM
```

E2E tests use a throwaway Appwrite project pointed at by
`APPWRITE_PROJECT_ID_TEST`. They never touch the real X API — `XSource` is
swapped for `XMockSource` in the test module.
