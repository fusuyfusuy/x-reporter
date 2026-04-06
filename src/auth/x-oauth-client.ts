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

export interface XOAuthClient {
  /** Build the URL to redirect the user to so they can authorize. */
  buildAuthorizeUrl(input: { state: string; codeChallenge: string }): string;
  /** Exchange an authorization code for tokens. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<XTokenResponse>;
  /** Refresh an existing access token. */
  refresh(refreshToken: string): Promise<XTokenResponse>;
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
}

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
    return await this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<XTokenResponse> {
    const basicAuth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');
    const res = await this.fetchImpl(this.config.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      // Read the body for diagnostics, but never log token contents — the
      // body of a token endpoint failure is an error envelope, not a real
      // token, so it's safe to surface in the message.
      const text = await res.text().catch(() => '');
      throw new Error(`x oauth token endpoint failed: ${res.status} ${text}`);
    }
    const json: unknown = await res.json();
    const parsed = XTokenResponseSchema.parse(json);
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresIn: parsed.expires_in,
      scope: parsed.scope,
    };
  }
}
