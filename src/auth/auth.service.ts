import { Injectable } from '@nestjs/common';
import { decrypt, encrypt } from '../common/crypto';
import { TokensRepo } from '../tokens/tokens.repo';
import { UsersRepo } from '../users/users.repo';
import { signCookieValue, verifyCookieValue } from './cookies';
import { deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce';
import type { XOAuthClient, XTokenResponse } from './x-oauth-client';

/**
 * `AuthService` is the orchestrator for the X OAuth2 PKCE flow plus the
 * transparent refresh helper that the rest of the system relies on. It
 * touches:
 *
 *   - `XOAuthClient` (port) — to talk to X's token endpoint.
 *   - `UsersRepo`         — to upsert / read users.
 *   - `TokensRepo`        — to persist already-encrypted tokens.
 *   - `crypto.encrypt/decrypt` — the only place that handles plaintext
 *     access/refresh tokens.
 *   - `cookies.sign/verify`     — for the PKCE state cookie and the
 *     session cookie.
 *
 * Why one orchestrator instead of split classes: each public method
 * represents a single user-facing operation (start sign-in, finish
 * sign-in, fetch a valid token for a worker). Splitting them would force
 * a chatty interface across files for no real isolation gain.
 *
 * IMPORTANT: this is the **only** module in `src/auth/` that ever holds
 * plaintext tokens in memory. Tokens enter via `XOAuthClient` (which
 * parses the X JSON response) and leave via either:
 *   - `TokensRepo.upsertForUser` (encrypted), or
 *   - the return value of `getValidAccessToken` (caller is responsible
 *     for not logging it).
 */

/**
 * Thrown by {@link AuthService.getValidAccessToken} when the stored
 * tokens cannot be refreshed (network error, X rejects the refresh, no
 * row exists). The user has been transitioned to `auth_expired` before
 * this error is raised, so the caller's only job is to bubble it up so
 * the worker / request can stop early.
 *
 * Subclasses Error directly so callers can `instanceof`-check it without
 * pulling in a third-party error library.
 */
export class AuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/**
 * Construction-time configuration. Built once at boot from `Env` by
 * `AuthModule.forRoot(env)`.
 */
export interface AuthServiceConfig {
  /** AES-256-GCM key (32 bytes). */
  encryptionKey: Uint8Array;
  /** HMAC-SHA256 secret used to sign the state and session cookies. */
  sessionSecret: string;
  /** Whether to set the `Secure` cookie attribute (true in production). */
  cookieSecure: boolean;
  /** Lifetime of the PKCE state cookie, in seconds. */
  stateCookieMaxAgeSec: number;
  /** Lifetime of the session cookie, in seconds. */
  sessionCookieMaxAgeSec: number;
}

/** Payload encoded into the signed PKCE state cookie. */
interface StateCookiePayload {
  state: string;
  codeVerifier: string;
  /** Epoch ms when the cookie was issued. */
  createdAt: number;
}

/** Payload encoded into the signed session cookie. */
export interface SessionCookiePayload {
  userId: string;
  /** Epoch ms when the session was issued. */
  issuedAt: number;
}

export interface StartAuthorizationResult {
  authorizeUrl: string;
  /** Signed value to put inside the `Set-Cookie` header for `xr_oauth_state`. */
  stateCookieValue: string;
}

export interface HandleCallbackInput {
  /** `code` query parameter from X's redirect. */
  code: string;
  /** `state` query parameter from X's redirect. */
  state: string;
  /** Raw value of the `xr_oauth_state` cookie sent by the browser. */
  stateCookieValue: string;
  /**
   * Strategy for resolving the X user identity from a fresh access token.
   * Injected as a callback (instead of being baked into `XOAuthClient`)
   * so this milestone can implement it inline once and revisit when
   * `XSource` (#6) lands.
   */
  lookupXUser: (accessToken: string) => Promise<{ xUserId: string; handle: string }>;
}

export interface HandleCallbackResult {
  userId: string;
  /** Signed value to put inside the `Set-Cookie` header for `xr_session`. */
  sessionCookieValue: string;
}

/** Refresh the token if it has fewer than this many ms left. */
const EXPIRY_SKEW_MS = 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly config: AuthServiceConfig,
    private readonly xClient: XOAuthClient,
    private readonly users: UsersRepo,
    private readonly tokens: TokensRepo,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // 1. Sign-in: redirect to authorize URL
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Generate a fresh `state` + `code_verifier`, derive the S256
   * `code_challenge`, build the X authorize URL, and produce the signed
   * state cookie value the controller should set on the response.
   */
  startAuthorization(): StartAuthorizationResult {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const authorizeUrl = this.xClient.buildAuthorizeUrl({ state, codeChallenge });
    const cookiePayload: StateCookiePayload = {
      state,
      codeVerifier,
      createdAt: Date.now(),
    };
    const stateCookieValue = signCookieValue(cookiePayload, this.config.sessionSecret);
    return { authorizeUrl, stateCookieValue };
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Sign-in: handle callback from X
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Validate the state cookie + query state, exchange the code for
   * tokens, encrypt and persist them, upsert the user, and produce the
   * signed session cookie value.
   */
  async handleCallback(input: HandleCallbackInput): Promise<HandleCallbackResult> {
    if (!input.stateCookieValue || input.stateCookieValue.length === 0) {
      throw new Error('missing state cookie');
    }
    const cookie = verifyCookieValue<StateCookiePayload>(
      input.stateCookieValue,
      this.config.sessionSecret,
    );
    if (!cookie) {
      throw new Error('invalid state cookie');
    }
    if (
      typeof cookie.state !== 'string' ||
      typeof cookie.codeVerifier !== 'string' ||
      typeof cookie.createdAt !== 'number'
    ) {
      throw new Error('invalid state cookie payload');
    }
    const ageMs = Date.now() - cookie.createdAt;
    if (ageMs > this.config.stateCookieMaxAgeSec * 1000) {
      throw new Error('state cookie expired');
    }
    if (cookie.state !== input.state) {
      throw new Error('state mismatch');
    }

    // 1. Exchange the code for tokens.
    const tokenResp: XTokenResponse = await this.xClient.exchangeCode({
      code: input.code,
      codeVerifier: cookie.codeVerifier,
    });

    // 2. Resolve the X user identity using the fresh access token.
    const { xUserId, handle } = await input.lookupXUser(tokenResp.accessToken);

    // 3. Upsert the user.
    const user = await this.users.upsertByXUserId({ xUserId, handle });

    // 4. Encrypt and persist the tokens.
    const expiresAtIso = new Date(Date.now() + tokenResp.expiresIn * 1000).toISOString();
    await this.tokens.upsertForUser({
      userId: user.id,
      accessToken: encrypt(tokenResp.accessToken, this.config.encryptionKey),
      refreshToken: encrypt(tokenResp.refreshToken, this.config.encryptionKey),
      expiresAt: expiresAtIso,
      scope: tokenResp.scope,
    });

    // 5. Issue the signed session cookie.
    const sessionPayload: SessionCookiePayload = {
      userId: user.id,
      issuedAt: Date.now(),
    };
    const sessionCookieValue = signCookieValue(sessionPayload, this.config.sessionSecret);

    return {
      userId: user.id,
      sessionCookieValue,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. getValidAccessToken — used by workers to call X v2 endpoints
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Return a valid plaintext access token for the given user, refreshing
   * transparently if needed. Throws `AuthExpiredError` if no usable
   * tokens exist (no row, refresh failed, etc.).
   */
  async getValidAccessToken(userId: string): Promise<string> {
    const row = await this.tokens.findByUserId(userId);
    if (!row) {
      throw new AuthExpiredError(`no tokens stored for user ${userId}`);
    }
    const expiresAtMs = Date.parse(row.expiresAt);
    const msUntilExpiry = expiresAtMs - Date.now();
    if (msUntilExpiry > EXPIRY_SKEW_MS) {
      // Still valid → just decrypt and return.
      return decrypt(row.accessToken, this.config.encryptionKey);
    }
    // Expired or near-expired → refresh.
    const refreshTokenPlain = decrypt(row.refreshToken, this.config.encryptionKey);
    let refreshed: XTokenResponse;
    try {
      refreshed = await this.xClient.refresh(refreshTokenPlain);
    } catch (err) {
      // Mark the user auth_expired so the next scheduled poll skips them.
      // Swallow any error from setStatus — we still want to throw the
      // AuthExpiredError so the caller stops, but never silently because
      // both legs failed.
      try {
        await this.users.setStatus(userId, 'auth_expired');
      } catch {
        // intentionally ignored — caller still receives AuthExpiredError
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthExpiredError(`refresh failed for user ${userId}: ${message}`);
    }
    // Persist the refreshed pair (encrypted) and return the new access
    // token.
    const newExpiresAtIso = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
    await this.tokens.upsertForUser({
      userId,
      accessToken: encrypt(refreshed.accessToken, this.config.encryptionKey),
      refreshToken: encrypt(refreshed.refreshToken, this.config.encryptionKey),
      expiresAt: newExpiresAtIso,
      scope: refreshed.scope,
    });
    return refreshed.accessToken;
  }
}
