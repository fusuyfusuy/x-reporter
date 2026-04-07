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
    req.user = { id: payload.userId };
    return true;
  }
}
