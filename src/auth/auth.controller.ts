import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthExpiredError, type AuthService } from './auth.service';
import { type CookieOptions, parseCookies, serializeCookie } from './cookies';

/**
 * HTTP surface for the X OAuth2 PKCE sign-in flow.
 *
 * Two endpoints:
 *
 *   - `GET /auth/x/start` — generates PKCE state + verifier, sets a
 *     signed short-lived `xr_oauth_state` cookie, and 302-redirects the
 *     browser to X's authorize URL.
 *
 *   - `GET /auth/x/callback?code=...&state=...` — validates the state
 *     cookie + query state via `AuthService.handleCallback`, clears the
 *     state cookie, sets a signed long-lived `xr_session` cookie, and
 *     302-redirects to `/me`.
 *
 * The controller is deliberately thin: zero business logic lives here.
 * Everything substantive (PKCE generation, state validation, code
 * exchange, encryption, persistence) is in `AuthService`. The controller
 * only translates between HTTP and the service's plain inputs/outputs.
 *
 * Error policy:
 *   - Missing query params or missing/invalid state cookie → 400.
 *   - `AuthExpiredError` from the service → 401 (the user must re-auth).
 *   - Any other throw from the service → 400 with a generic message. We
 *     never leak stack traces or service internals to the response body.
 */

/** Cookie names used by the auth flow. */
export const STATE_COOKIE_NAME = 'xr_oauth_state';
export const SESSION_COOKIE_NAME = 'xr_session';

/**
 * Runtime config needed by the controller. Built once at boot from `Env`
 * and injected via `AuthModule.forRoot(env)`.
 */
export interface AuthControllerConfig {
  /** Whether to set the `Secure` cookie attribute (true in production). */
  cookieSecure: boolean;
  /** Lifetime of the PKCE state cookie, in seconds. */
  stateCookieMaxAgeSec: number;
  /** Lifetime of the session cookie, in seconds. */
  sessionCookieMaxAgeSec: number;
}

@Controller('auth/x')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly config: AuthControllerConfig,
  ) {}

  @Get('start')
  start(@Res() res: Response): void {
    const { authorizeUrl, stateCookieValue } = this.service.startAuthorization();
    const stateCookie = serializeCookie(
      STATE_COOKIE_NAME,
      stateCookieValue,
      this.stateCookieOpts(this.config.stateCookieMaxAgeSec),
    );
    res.setHeader('Set-Cookie', stateCookie);
    res.redirect(302, authorizeUrl);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const query = req.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';
    if (code.length === 0 || state.length === 0) {
      // Clear any leftover state cookie on the way out so a stale one
      // can't haunt future requests.
      res.setHeader('Set-Cookie', this.clearStateCookieHeader());
      res.status(400).send('missing code or state');
      return;
    }

    const cookieHeader =
      typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    const cookies = parseCookies(cookieHeader);
    const stateCookieValue = cookies[STATE_COOKIE_NAME] ?? '';
    if (stateCookieValue.length === 0) {
      res.setHeader('Set-Cookie', this.clearStateCookieHeader());
      res.status(400).send('missing state cookie');
      return;
    }

    try {
      const result = await this.service.handleCallback({
        code,
        state,
        stateCookieValue,
      });
      const sessionCookie = serializeCookie(
        SESSION_COOKIE_NAME,
        result.sessionCookieValue,
        this.sessionCookieOpts(this.config.sessionCookieMaxAgeSec),
      );
      // Two Set-Cookie headers: one clears the short-lived state cookie,
      // one installs the session cookie.
      res.setHeader('Set-Cookie', [this.clearStateCookieHeader(), sessionCookie]);
      res.redirect(302, '/me');
    } catch (err) {
      res.setHeader('Set-Cookie', this.clearStateCookieHeader());
      if (err instanceof AuthExpiredError) {
        res.status(401).send('auth expired');
        return;
      }
      // Every other error (state mismatch, expired state cookie, signature
      // mismatch, code-exchange failure, persistence failure, ...) becomes
      // a generic 400. The underlying message stays in the server logs via
      // nestjs-pino — only a short string is returned in the body.
      res.status(400).send('invalid auth callback');
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private stateCookieOpts(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      maxAge,
      path: '/auth/x',
    };
  }

  private sessionCookieOpts(maxAge: number): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      maxAge,
      path: '/',
    };
  }

  private clearStateCookieHeader(): string {
    return serializeCookie(STATE_COOKIE_NAME, '', this.stateCookieOpts(0));
  }
}
