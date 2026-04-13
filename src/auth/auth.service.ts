import { Injectable, Logger } from '@nestjs/common';
import { decrypt, encrypt } from '../common/crypto';
import { ScheduleService } from '../schedule/schedule.service';
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: AuthServiceConfig,
    private readonly xClient: XOAuthClient,
    private readonly users: UsersRepo,
    private readonly tokens: TokensRepo,
    private readonly schedule: ScheduleService,
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
    // Defense in depth: the controller already validates `code` and
    // `state` against the query string before we get here, but a future
    // caller (BG job, integration test, alternate transport) could call
    // the service directly. A blank `code` would otherwise be forwarded
    // to `xClient.exchangeCode()` and surface as an upstream-failure
    // (502) instead of the typed validation-failure path used for every
    // other malformed callback.
    if (!input.stateCookieValue) {
      throw new InvalidAuthCallbackError('missing state cookie');
    }
    if (!input.code) {
      throw new InvalidAuthCallbackError('missing code');
    }
    if (!input.state) {
      throw new InvalidAuthCallbackError('missing state');
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

    // 6. Register the user's repeatable jobs (poll-x, build-digest)
    //    via ScheduleService. This is the LAST step of the callback —
    //    tokens are already persisted and the session cookie is already
    //    minted, so if the schedule call throws the caller receives an
    //    upstream-502 via the controller's existing exception mapping
    //    (same shape as other upstream dependency failures). A warning
    //    log fires first so the failure is attributable in structured
    //    logs before the throw propagates.
    //
    //    We deliberately do NOT swallow the error here: a half-wired
    //    sign-in (tokens persisted but no schedule entry) would silently
    //    result in a user who never gets polled, which is worse than an
    //    explicit failure. The next retry of the OAuth flow will either
    //    re-upsert the schedule entry (no harm done — upsert is
    //    idempotent) or surface the same scheduler outage again.
    try {
      await this.schedule.upsertJobsForUser(user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `handleCallback: schedule.upsertJobsForUser failed for user ${user.id}: ${message}`,
      );
      throw err;
    }

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
    //
    // CRITICAL: X has already accepted the refresh by this point and (in
    // the rotating-token path) invalidated the previous refresh token. If
    // the local upsert now fails, we are stranded: the next poll would
    // load the *old* row, send the now-invalid old refresh token to X,
    // and get back `invalid_grant`. Worse, the user would still be
    // marked `active`, so scheduled callers would keep retrying a
    // permanently broken account. Convert the persistence failure into
    // an explicit `auth_expired` transition so re-auth is the only path
    // forward, instead of leaking a raw repo error through workers.
    const newExpiresAtIso = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
    try {
      await this.tokens.upsertForUser({
        userId,
        accessToken: encrypt(refreshed.accessToken, this.config.encryptionKey),
        refreshToken: encrypt(refreshed.refreshToken, this.config.encryptionKey),
        expiresAt: newExpiresAtIso,
        scope: refreshed.scope,
      });
    } catch (err) {
      await this.failAuth(userId);
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthExpiredError(
        `refreshed tokens could not be persisted for user ${userId}: ${message}`,
      );
    }
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
   *
   * After a successful status transition we also call
   * `schedule.removeJobsForUser(userId)` so the BullMQ repeatables stop
   * firing against a user who can no longer be polled. The removal runs
   * inside its own try/catch so a queue outage can never mask the
   * original auth failure — the caller still receives the typed
   * `AuthExpiredError`, and the removal is logged at `warn` if it
   * fails. `removeJobsForUser` is itself idempotent (no error if the
   * scheduler keys do not exist), so running it unconditionally here is
   * safe even for users that never had repeatables registered.
   *
   * The removal is gated on `setStatus` succeeding: if the status
   * transition itself failed we skip the removal because the user row
   * is in an indeterminate state — a future retry (same user, same
   * failure path) will re-attempt both in order. Attempting the
   * removal anyway would risk a stuck user whose `status` is still
   * `active` but whose repeatables have been silently drained,
   * producing a surprising state for operators.
   */
  private async failAuth(userId: string): Promise<void> {
    let statusUpdated = false;
    try {
      await this.users.setStatus(userId, 'auth_expired');
      statusUpdated = true;
    } catch (err) {
      // Intentionally do not rethrow — the caller still receives the
      // typed `AuthExpiredError` and the request stops cleanly. But
      // silently swallowing every failure would hide a persistent
      // database connectivity issue (e.g., Appwrite outage), so log at
      // `warn` for observability. The userId is non-sensitive; the err
      // is from `users.setStatus` which never sees token plaintext, so
      // there's nothing to redact here.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `failed to set auth_expired for user ${userId}: ${message}`,
      );
    }

    if (!statusUpdated) {
      // Don't touch repeatables until the row is known to be in the
      // terminal `auth_expired` state. Retries will reconcile both.
      return;
    }

    try {
      await this.schedule.removeJobsForUser(userId);
    } catch (err) {
      // Same swallow-and-log policy as `setStatus`: the caller already
      // holds the typed AuthExpiredError and the user row is already
      // in the terminal `auth_expired` state. A queue outage here only
      // means the repeatable entries in Redis are stale; the workers
      // themselves will skip a user whose row is `auth_expired` (per
      // the poll-x processor contract arriving in #7).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `failed to remove schedule entries for user ${userId}: ${message}`,
      );
    }
  }
}
