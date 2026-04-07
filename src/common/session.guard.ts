import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SESSION_COOKIE_NAME } from '../auth/auth.controller';
import { parseCookies, verifyCookieValue } from '../auth/cookies';
import type { SessionCookiePayload } from '../auth/auth.service';

/**
 * `SessionGuard` is the only auth gate on `/me` (and the future
 * `/digests` endpoints in milestone #11). It is intentionally tiny:
 *
 *   1. Read the `xr_session` cookie out of the incoming `Cookie`
 *      header using the same `parseCookies` helper the auth callback
 *      already uses.
 *   2. Verify the HMAC signature with the same `SESSION_SECRET` that
 *      `AuthService.handleCallback` used to sign it. We use
 *      `verifyCookieValue<SessionCookiePayload>` so the payload type
 *      lines up exactly with what the auth module emits.
 *   3. Validate the decoded payload (`userId` is a non-empty string).
 *      A `null` from `verifyCookieValue` (bad signature, malformed
 *      base64, JSON parse error) and a malformed payload both produce
 *      a `401`.
 *   4. Attach `req.user = { id }` so controllers can read the caller
 *      via `@Req()` (or a future `@CurrentUser()` decorator) without
 *      re-parsing the cookie.
 *
 * Why hand-rolled instead of `@nestjs/passport`: the auth module
 * already has zero third-party deps for cookie signing/verification
 * (see `src/auth/cookies.ts`). Reusing those primitives keeps the
 * codebase honest about having exactly one signing scheme. Passport
 * would force two: its own session strategy plus our existing
 * `signCookieValue`/`verifyCookieValue`.
 *
 * Why `src/common/` and not `src/users/`: milestone #11 (`feat(workers):
 * build-digest processor + /digests endpoints`) reuses the same guard
 * for `/digests`. Putting it under `users/` would force a cross-module
 * import that the digest module shouldn't need.
 */

/**
 * Construction-time configuration. Built once at boot from `Env` and
 * passed in via the `SESSION_GUARD_CONFIG` provider token. Holding the
 * secret on a small config object (rather than reading from env on
 * every request) keeps the guard cheap to instantiate in tests.
 */
export interface SessionGuardConfig {
  /** HMAC-SHA256 secret used to verify the session cookie. */
  sessionSecret: string;
  /**
   * Maximum age (in seconds) of an `xr_session` cookie before the
   * guard rejects it as expired. Must match the `Max-Age` value
   * `AuthController` sets on the `Set-Cookie` response (and the
   * `SESSION_COOKIE_MAX_AGE_SEC` constant exported by `AuthModule`),
   * so the signing and verifying sides agree on a single lifetime.
   * Without a server-side check a stolen cookie could outlive the
   * browser's `Max-Age` window indefinitely.
   */
  sessionMaxAgeSec: number;
}

/** DI token for {@link SessionGuardConfig}. */
export const SESSION_GUARD_CONFIG = 'SessionGuardConfig';

/**
 * Build the standard `{ error: { code, message, details } }` envelope
 * documented in `docs/api.md#errors`. Defined inline (rather than
 * imported from a future shared module) so the guard has zero
 * cross-module deps; #11 will hoist this to a shared helper once
 * `/digests` becomes the second emitter of structured 401s.
 */
function unauthorizedBody(): {
  error: { code: string; message: string; details: Record<string, never> };
} {
  return {
    error: {
      code: 'unauthorized',
      message: 'unauthorized',
      details: {},
    },
  };
}

/**
 * Minimal structural type for the express-style request the guard
 * actually touches. Declared here (rather than imported from `express`)
 * for the same reason `AuthController` does it: avoid pulling
 * `@types/express` into devDependencies for a handful of fields.
 */
interface ExpressLikeRequest {
  headers: { cookie?: string | undefined } & Record<string, unknown>;
  user?: { id: string };
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(SESSION_GUARD_CONFIG)
    private readonly config: SessionGuardConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ExpressLikeRequest>();
    const cookieHeader =
      typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    const cookies = parseCookies(cookieHeader);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new UnauthorizedException(unauthorizedBody());
    }
    const payload = verifyCookieValue<SessionCookiePayload>(
      raw,
      this.config.sessionSecret,
    );
    if (!payload) {
      // `verifyCookieValue` returns `null` for any structural failure
      // (missing dot, bad base64, JSON parse error, signature
      // mismatch). All of those collapse to "the caller does not have
      // a valid session" → 401.
      throw new UnauthorizedException(unauthorizedBody());
    }
    if (typeof payload.userId !== 'string' || payload.userId.length === 0) {
      // Correctly signed by *us* but the payload shape is wrong. Treat
      // the same as a tampered cookie — never attach an empty / non-
      // string id to the request.
      throw new UnauthorizedException(unauthorizedBody());
    }
    // Server-side expiry check. `AuthService` writes `issuedAt` as
    // `Date.now()` (epoch ms) when minting the session cookie, and
    // sets `Max-Age = sessionMaxAgeSec` on the `Set-Cookie` response
    // so well-behaved browsers stop sending the cookie after that
    // window. But the browser's `Max-Age` is purely advisory: a
    // stolen cookie could be replayed indefinitely without this
    // check. We treat any of the following as expired/invalid:
    //
    //   - missing `issuedAt` or non-finite (e.g. tampered to bypass)
    //   - in the future by more than the configured skew (clock
    //     drift between issuer and verifier — we allow a small
    //     forward window so test fixtures stamped one tick ahead
    //     don't 401)
    //   - older than `sessionMaxAgeSec`
    //
    // Failure collapses to the same `unauthorized` envelope as every
    // other 401 path so clients see one shape.
    if (typeof payload.issuedAt !== 'number' || !Number.isFinite(payload.issuedAt)) {
      throw new UnauthorizedException(unauthorizedBody());
    }
    const ageMs = Date.now() - payload.issuedAt;
    const maxAgeMs = this.config.sessionMaxAgeSec * 1000;
    // Skew handling is symmetric: both bounds get the same tolerance
    // window so a verifier whose clock is a few seconds ahead of the
    // issuer can't reject still-valid sessions early, just as a
    // verifier whose clock is behind can't choke on a freshly minted
    // cookie that looks like it's "from the future".
    if (
      ageMs < -CLOCK_SKEW_TOLERANCE_MS ||
      ageMs > maxAgeMs + CLOCK_SKEW_TOLERANCE_MS
    ) {
      throw new UnauthorizedException(unauthorizedBody());
    }
    req.user = { id: payload.userId };
    return true;
  }
}

/**
 * Allow the verifier's clock to be up to 5 seconds behind the issuer's
 * before rejecting an `issuedAt` that appears to be in the future. The
 * issuer is the same process in production but tests sometimes mint
 * cookies with `Date.now() + 1` to lock specific behavior; this skew
 * keeps the guard from being a flaky-test source.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;
