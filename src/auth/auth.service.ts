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
 * Thrown by {@link AuthService.handleCallback} when the inbound callback
 * is malformed or has been tampered with: missing/expired/invalid state
 * cookie, signature mismatch, or query-state mismatch. These are all
 * client-side faults and should surface as `400` to the browser.
 *
 * Anything *not* of this type that escapes `handleCallback` (X timeouts,
 * token-endpoint 5xx, Appwrite write failures, ...) is a server-side or
 * upstream-dependency failure, and the controller maps it to `502` so
 * monitoring and clients can tell the two cases apart.
 */
export class InvalidAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuthCallbackError';
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
}

export interface HandleCallbackResult {
  userId: string;
  /** Signed value to put inside the `Set-Cookie` header for `xr_session`. */
  sessionCookieValue: string;
}

/** Refresh the token if it has fewer than this many ms left. */
const EXPIRY_SKEW_MS = 60 * 1000;

/**
 * Maximum number of times {@link AuthService.getValidAccessToken} will
 * recursively re-enter to recover from a stale-refresh race. One retry
 * is enough in practice — the parallel winner has already persisted —
 * but the cap exists so a genuinely broken account still terminates
 * instead of looping.
 */
const MAX_REFRESH_RACE_RETRIES = 1;

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
    if (!input.stateCookieValue) {
      throw new InvalidAuthCallbackError('missing state cookie');
    }
    const cookie = verifyCookieValue<StateCookiePayload>(
      input.stateCookieValue,
      this.config.sessionSecret,
    );
    if (!cookie) {
      throw new InvalidAuthCallbackError('invalid state cookie');
    }
    if (
      typeof cookie.state !== 'string' ||
      typeof cookie.codeVerifier !== 'string' ||
      typeof cookie.createdAt !== 'number'
    ) {
      throw new InvalidAuthCallbackError('invalid state cookie payload');
    }
    const ageMs = Date.now() - cookie.createdAt;
    if (ageMs > this.config.stateCookieMaxAgeSec * 1000) {
      throw new InvalidAuthCallbackError('state cookie expired');
    }
    if (cookie.state !== input.state) {
      throw new InvalidAuthCallbackError('state mismatch');
    }

    // 1. Exchange the code for tokens.
    const tokenResp: XTokenResponse = await this.xClient.exchangeCode({
      code: input.code,
      codeVerifier: cookie.codeVerifier,
    });

    // 2. Resolve the X user identity using the fresh access token.
    const { xUserId, handle } = await this.xClient.getMe(tokenResp.accessToken);

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
    return await this.getValidAccessTokenInner(userId, 0);
  }

  /**
   * Internal recursive impl. The `attempt` counter exists for the
   * stale-refresh-race recovery path: if our refresh call returns
   * `invalid_grant` *because another worker already rotated the token*,
   * we re-enter once with the freshly persisted row. The depth guard
   * prevents an infinite loop if something else is genuinely wrong.
   */
  private async getValidAccessTokenInner(
    userId: string,
    attempt: number,
  ): Promise<string> {
    const row = await this.tokens.findByUserId(userId);
    if (!row) {
      // No row at all — partial callback persistence, manual deletion,
      // or a deleted user. The only recovery is re-auth, so transition
      // the user to auth_expired before bubbling so scheduled callers
      // stop retrying a permanently broken account.
      await this.failAuth(userId);
      throw new AuthExpiredError(`no tokens stored for user ${userId}`);
    }
    // Parse expiresAt up front. A NaN here means the stored row is corrupt
    // (truncated, hand-edited, or written by an older format) — there's no
    // safe way to "use" or "refresh" an unknown expiry, so treat it the same
    // as a hard auth failure.
    const expiresAtMs = Date.parse(row.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      await this.failAuth(userId);
      throw new AuthExpiredError(
        `tokens row for user ${userId} has malformed expiresAt`,
      );
    }
    const msUntilExpiry = expiresAtMs - Date.now();
    if (msUntilExpiry > EXPIRY_SKEW_MS) {
      // Still valid → just decrypt and return. A decrypt failure here means
      // the ciphertext was tampered with or the encryption key changed — in
      // either case the row is unusable, transition the user to auth_expired
      // and surface the typed error so callers handle it consistently.
      try {
        return decrypt(row.accessToken, this.config.encryptionKey);
      } catch (err) {
        await this.failAuth(userId);
        const message = err instanceof Error ? err.message : String(err);
        throw new AuthExpiredError(
          `failed to decrypt access token for user ${userId}: ${message}`,
        );
      }
    }
    // Expired or near-expired → refresh. Same treatment for a refresh-token
    // decrypt failure: there's nothing left to try, so it's an auth failure.
    let refreshTokenPlain: string;
    try {
      refreshTokenPlain = decrypt(row.refreshToken, this.config.encryptionKey);
    } catch (err) {
      await this.failAuth(userId);
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthExpiredError(
        `failed to decrypt refresh token for user ${userId}: ${message}`,
      );
    }
    let refreshed: XTokenResponse;
    try {
      refreshed = await this.xClient.refresh(refreshTokenPlain);
    } catch (err) {
      // STALE-REFRESH RACE GUARD: with multiple workers, one caller can
      // refresh + persist a rotated token while another is still in
      // flight against the *previous* refresh token. X correctly returns
      // `invalid_grant` for the slow caller — but the user's credentials
      // are NOT actually expired, fresh ones were just persisted under
      // our feet. Re-read the row; if the stored refresh-token ciphertext
      // changed between our load and now, a parallel worker won the
      // race, so retry once with the new row instead of expiring the
      // user. The attempt counter caps the recursion so a genuinely
      // broken account still terminates.
      const current = await this.tokens.findByUserId(userId);
      if (
        current &&
        current.refreshToken !== row.refreshToken &&
        attempt < MAX_REFRESH_RACE_RETRIES
      ) {
        return await this.getValidAccessTokenInner(userId, attempt + 1);
      }
      await this.failAuth(userId);
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

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Best-effort transition of a user to `auth_expired` after any
   * unrecoverable token failure (refresh rejected, decrypt failed,
   * malformed expiresAt). Errors from `setStatus` are swallowed so the
   * caller still receives the typed `AuthExpiredError` — the goal is to
   * stop scheduled polls for this user, not to mask the original failure.
   */
  private async failAuth(userId: string): Promise<void> {
    try {
      await this.users.setStatus(userId, 'auth_expired');
    } catch {
      // intentionally ignored — caller still receives AuthExpiredError
    }
  }
}
