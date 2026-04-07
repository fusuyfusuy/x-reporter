# REST API

Base URL: `http://localhost:3000` in dev. All authenticated endpoints require
the session cookie set by `/auth/x/callback`.

## Auth

### `GET /auth/x/start`
Begins X OAuth2 PKCE flow. Generates `state` + `code_verifier`, stores them in
a short-lived signed cookie, and 302-redirects to X's authorize URL.

**Response:** `302` to `https://twitter.com/i/oauth2/authorize?...`

### `GET /auth/x/callback?code=...&state=...`
Validates `state`, exchanges `code` for tokens, encrypts and persists them,
upserts the `users` row, registers BullMQ repeatable jobs, and issues a
session cookie.

**Response:** `302` to `/me` on success, `400` on state mismatch.

## Me

Both endpoints are gated by the `xr_session` cookie issued by
`/auth/x/callback`. Missing, malformed, or tampered cookies produce
`401`. The cadence fields default to `60` (poll) and `1440` (digest) as
documented in [data-model.md](./data-model.md#users) — clients always
see numbers, never `null`.

### `GET /me`

**Auth:** required.

```json
{
  "id": "u_abc",
  "xUserId": "12345",
  "handle": "fusuyfusuy",
  "pollIntervalMin": 60,
  "digestIntervalMin": 1440,
  "status": "active",
  "createdAt": "2026-04-06T12:00:00Z"
}
```

`404` if the session cookie's user id no longer matches a stored row
(e.g. account deleted between sign-in and request).

### `PATCH /me`

**Auth:** required.

```json
{ "pollIntervalMin": 30, "digestIntervalMin": 720 }
```

Both fields optional, but at least one MUST be provided. Server
validates with a strict zod schema: integers, `pollIntervalMin >= 5`,
`digestIntervalMin >= 15`, no unknown keys. Validation failures produce
`400` with the standard `validation_failed` error envelope. On success,
`ScheduleService.upsertJobsForUser` re-registers the user's repeatable
jobs with the new intervals.

**Response:** `200` with the updated `/me` payload (same shape as
`GET /me`).

**Failure modes:**
- `400 validation_failed` — body fails the zod schema (missing both
  fields, value below minimum, non-integer, unknown key).
- `401 unauthorized` — session cookie missing, malformed, or tampered.
- `404 not_found` — session cookie's user id no longer exists.
- `502 internal` — repo write succeeded but the post-write
  `ScheduleService.upsertJobsForUser` call failed. The cadence change
  is committed; the next successful PATCH reconciles the schedule.

## Digests

### `GET /digests?limit=20&cursor=<id>`
**Auth:** required. Returns the current user's digests, newest first.

```json
{
  "items": [
    {
      "id": "d_xyz",
      "windowStart": "2026-04-05T00:00:00Z",
      "windowEnd": "2026-04-06T00:00:00Z",
      "model": "anthropic/claude-sonnet-4.5",
      "createdAt": "2026-04-06T00:05:12Z",
      "preview": "## Top stories\n- ..."
    }
  ],
  "nextCursor": "d_prev"
}
```

`preview` is the first ~200 chars of `markdown`.

### `GET /digests/:id`
**Auth:** required. Full digest including `markdown` and `itemIds`.

```json
{
  "id": "d_xyz",
  "userId": "u_abc",
  "windowStart": "2026-04-05T00:00:00Z",
  "windowEnd": "2026-04-06T00:00:00Z",
  "markdown": "## Top stories\n...",
  "itemIds": ["i_1", "i_2"],
  "model": "anthropic/claude-sonnet-4.5",
  "tokensIn": 12345,
  "tokensOut": 678,
  "createdAt": "2026-04-06T00:05:12Z"
}
```

`404` if the digest does not belong to the caller.

### `POST /digests/run-now`
**Auth:** required. Enqueues a one-shot `build-digest` job for the caller.

**Response:** `202` with `{ "jobId": "...", "queuedAt": "..." }`.

## Health

### `GET /health`
Public. Returns `200` with:

```json
{ "status": "ok", "redis": "ok", "appwrite": "ok" }
```

Each subsystem field is `ok` or an error string. Returns `503` if any are not `ok`.

## Errors

All errors follow:

```json
{ "error": { "code": "string", "message": "string", "details": {} } }
```

Common codes: `unauthorized`, `not_found`, `validation_failed`,
`auth_expired`, `rate_limited`, `internal`.
