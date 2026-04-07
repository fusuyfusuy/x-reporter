import { z } from 'zod';

/**
 * Port + adapter for X's OAuth2 token endpoint.
 *
 * `XOAuthClient` is the only thing `AuthService` knows about for talking to
 * X. The default `HttpXOAuthClient` implementation wraps Bun's native
 * `fetch`. Tests inject a fake `fetch` (or a fake client) so no network
 * call is made.
 *
 * NOTE: this port is **separate** from `XSource` (`docs/interfaces.md` §1).
 * `XSource` covers reading likes/bookmarks; `XOAuthClient` covers the
 * sign-in / refresh handshake. Both happen to talk to api.twitter.com but
 * the lifecycle, error model, and call sites are different enough to keep
 * them as two ports rather than one bloated interface.
 */

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface XTokenResponse {
  /** OAuth2 access token (bearer). */
  accessToken: string;
  /** OAuth2 refresh token. */
  refreshToken: string;
  /** Lifetime of `accessToken` in seconds. */
  expiresIn: number;
  /** Space-separated list of granted scopes. */
  scope: string;
}

export interface XUserInfo {
  /** X numeric user id (snowflake). */
  xUserId: string;
  /** X handle without the leading `@`. */
  handle: string;
}

export interface XOAuthClient {
  /** Build the URL to redirect the user to so they can authorize. */
  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string;
  /** Exchange an authorization code for tokens. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse>;
  /** Refresh an existing access token. */
  refresh(refreshToken: string): Promise<XTokenResponse>;
  /**
   * Resolve the authenticated X user identity from a fresh access token.
   * Used immediately after `exchangeCode` to bootstrap the `users` row.
   *
   * Lives on this port (rather than `XSource`) because it's part of the
   * sign-in handshake, not the data-ingestion seam. Keeping it here also
   * means the auth module never has to import anything from
   * `src/ingestion/`, preserving directional decoupling.
   */
  getMe(accessToken: string): Promise<XUserInfo>;
}

export interface XOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Space-separated scopes (e.g. "tweet.read users.read offline.access"). */
  scopes: string;
  /** X authorize endpoint. */
  authorizeEndpoint: string;
  /** X token endpoint. */
  tokenEndpoint: string;
  /** X `/2/users/me` endpoint. */
  userInfoEndpoint: string;
  /**
   * Per-request network timeout for outbound calls to X, in milliseconds.
   * Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS} when omitted. Without a
   * timeout a stalled X endpoint can leave `/auth/x/callback` (or a
   * background token refresh) hanging indefinitely.
   */
  fetchTimeoutMs?: number;
}

/** Default timeout for outbound calls to X (10s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Zod schema for the X token endpoint response. Exported so the auth
 * module's tests can sanity-check fixtures, and so the adapter parses
 * untrusted input at the boundary.
 */
export const XTokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});

/**
 * Refresh-response schema. Per RFC 6749 §6 the authorization server MAY
 * omit `refresh_token` when the existing refresh token remains valid, and
 * X's docs do not contradict that. So `refresh_token` is optional here and
 * the caller falls back to the previous refresh token when absent. Keep
 * the strict {@link XTokenResponseSchema} for the initial code-exchange
 * path where the server is required to issue both tokens.
 */
export const XRefreshTokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});

/**
 * Zod schema for `GET /2/users/me` (X API v2). Only the fields the auth
 * flow actually consumes are required; everything else is ignored.
 */
export const XUserInfoResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    username: z.string().min(1),
  }),
});

// ────────────────────────────────────────────────────────────────────────────
// Default impl
// ────────────────────────────────────────────────────────────────────────────

/**
 * The only place in the auth module that calls `fetch` against X. Accepts
 * a `fetch` impl in the constructor so tests can inject a fake without
 * monkey-patching the global.
 */
export class HttpXOAuthClient implements XOAuthClient {
  constructor(
    private readonly config: XOAuthClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.config.authorizeEndpoint}?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: this.config.clientId,
    });
    return await this.postToken(body);
  }

  async refresh(refreshToken: string): Promise<XTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });
    return await this.postToken(body, refreshToken);
  }

  async getMe(accessToken: string): Promise<XUserInfo> {
    return await this.fetchWithTimeout(
      this.config.userInfoEndpoint,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
      },
      async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `x users/me endpoint failed: ${res.status} ${truncateForError(text)}`,
          );
        }
        const json: unknown = await res.json();
        const parsed = XUserInfoResponseSchema.parse(json);
        return { xUserId: parsed.data.id, handle: parsed.data.username };
      },
    );
  }

  /**
   * POST the token endpoint and parse the response.
   *
   * When `fallbackRefreshToken` is supplied (the refresh-token flow),
   * `refresh_token` may be omitted from the response per RFC 6749 §6 — in
   * that case the previous refresh token is reused. The initial code
   * exchange flow does NOT pass a fallback, so `refresh_token` is required
   * there via {@link XTokenResponseSchema}.
   */
  private async postToken(
    body: URLSearchParams,
    fallbackRefreshToken?: string,
  ): Promise<XTokenResponse> {
    const basicAuth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');
    return await this.fetchWithTimeout(
      this.config.tokenEndpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: `Basic ${basicAuth}`,
        },
        body: body.toString(),
      },
      async (res) => {
        if (!res.ok) {
          // Read the body for diagnostics, but never log token contents —
          // the body of a token endpoint failure is an error envelope, not
          // a real token, so it's safe to surface in the message. Still
          // truncate it for defense-in-depth: an unexpected upstream
          // response could carry request ids or partial credential-shaped
          // data, and an unbounded body bloats logs.
          const text = await res.text().catch(() => '');
          throw new Error(
            `x oauth token endpoint failed: ${res.status} ${truncateForError(text)}`,
          );
        }
        const json: unknown = await res.json();
        if (fallbackRefreshToken !== undefined) {
          const parsed = XRefreshTokenResponseSchema.parse(json);
          return {
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token ?? fallbackRefreshToken,
            expiresIn: parsed.expires_in,
            scope: parsed.scope,
          };
        }
        const parsed = XTokenResponseSchema.parse(json);
        return {
          accessToken: parsed.access_token,
          refreshToken: parsed.refresh_token,
          expiresIn: parsed.expires_in,
          scope: parsed.scope,
        };
      },
    );
  }

  /**
   * Wrap `fetchImpl` with an `AbortController` so a stalled X endpoint
   * can never hang the request indefinitely. Translates the resulting
   * `AbortError` into a clear, redacted error message — no token data is
   * ever in scope here, only the URL.
   *
   * Critically, the timeout scope **also covers body consumption**. The
   * `consume` callback receives the `Response` and reads its body via
   * `res.json()`/`res.text()`; the timer is only cleared after `consume`
   * resolves. Without this, a server that flushes headers and then stalls
   * the body stream would still hang the request indefinitely — `fetch()`
   * resolves as soon as headers arrive, and `Response.json()` separately
   * reads the stream to completion.
   */
  private async fetchWithTimeout<T>(
    url: string,
    init: RequestInit,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      return await consume(res);
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`x request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

/** Maximum number of body characters to include in a thrown error message. */
const ERROR_BODY_MAX_CHARS = 200;

/**
 * Clamp an upstream response body for inclusion in an `Error` message.
 * Token-endpoint failures are error envelopes (not real tokens), but an
 * unbounded body can still leak request ids or bloat logs, so we cap it.
 */
function truncateForError(body: string): string {
  if (body.length <= ERROR_BODY_MAX_CHARS) return body;
  return `${body.slice(0, ERROR_BODY_MAX_CHARS)}…[truncated]`;
}
