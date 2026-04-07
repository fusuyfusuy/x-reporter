import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { SESSION_COOKIE_NAME } from '../auth/auth.controller';
import { signCookieValue } from '../auth/cookies';
import { SessionGuard } from './session.guard';

/**
 * `SessionGuard` is the only auth gate on `/me` (and the future
 * `/digests` endpoints in #11). The contract:
 *
 *   - Reads the `xr_session` cookie out of the incoming `Cookie` header.
 *   - Verifies it with the same HMAC secret the auth module signed it
 *     with (`AuthService.handleCallback` issues it via
 *     `signCookieValue`, this guard verifies via `verifyCookieValue`).
 *   - On success: attaches `req.user = { id }` so controllers can read
 *     the caller's id without re-parsing the cookie.
 *   - On failure: throws `UnauthorizedException` (Nest maps that to
 *     `401`). Failure cases:
 *       1. No `Cookie` header at all.
 *       2. `Cookie` header present but no `xr_session` entry.
 *       3. `xr_session` value has a bad signature (tampered).
 *       4. `xr_session` value decodes but the payload is malformed
 *          (missing `userId` string).
 *
 * The guard is intentionally Passport-free and has no third-party
 * dependencies — it shares the same primitives as `AuthService` so
 * there is exactly one signing scheme in the codebase.
 */

const SECRET = 'a-test-session-secret-at-least-32-chars-long';

interface FakeReqHeaders {
  cookie?: string;
}

interface FakeReq {
  headers: FakeReqHeaders;
  user?: { id: string };
}

function makeContext(req: FakeReq): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
    // The guard only reaches for switchToHttp(); the other facets are
    // unused but ExecutionContext requires the shape, so stub them out.
    // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext stub
  } as any;
}

function makeGuard(): SessionGuard {
  return new SessionGuard({ sessionSecret: SECRET });
}

function mintSessionCookieValue(userId: string): string {
  return signCookieValue({ userId, issuedAt: Date.now() }, SECRET);
}

function buildCookieHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

describe('SessionGuard', () => {
  describe('happy path', () => {
    it('attaches req.user.id and returns true for a valid signed cookie', () => {
      const guard = makeGuard();
      const value = mintSessionCookieValue('u_abc');
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      const result = guard.canActivate(makeContext(req));
      expect(result).toBe(true);
      expect(req.user).toEqual({ id: 'u_abc' });
    });

    it('tolerates extra cookies in the header', () => {
      const guard = makeGuard();
      const value = mintSessionCookieValue('u_abc');
      const cookieHeader = `other=foo; ${buildCookieHeader(
        SESSION_COOKIE_NAME,
        value,
      )}; tail=bar`;
      const req: FakeReq = { headers: { cookie: cookieHeader } };
      expect(guard.canActivate(makeContext(req))).toBe(true);
      expect(req.user?.id).toBe('u_abc');
    });
  });

  describe('401 paths', () => {
    it('throws Unauthorized when there is no Cookie header at all', () => {
      const guard = makeGuard();
      const req: FakeReq = { headers: {} };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
      expect(req.user).toBeUndefined();
    });

    it('throws Unauthorized when the Cookie header is present but xr_session is missing', () => {
      const guard = makeGuard();
      const req: FakeReq = { headers: { cookie: 'other=foo; another=bar' } };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when the signature does not verify (tampered cookie)', () => {
      const guard = makeGuard();
      const value = mintSessionCookieValue('u_abc');
      // Flip a character in the signature half (after the dot) so the
      // HMAC stops matching but the payload half still parses.
      const dot = value.indexOf('.');
      const tamperedSig = `${value.slice(dot + 1, dot + 2) === 'A' ? 'B' : 'A'}${value.slice(dot + 2)}`;
      const tampered = `${value.slice(0, dot + 1)}${tamperedSig}`;
      const req: FakeReq = {
        headers: {
          cookie: buildCookieHeader(SESSION_COOKIE_NAME, tampered),
        },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when the value is signed with a different secret', () => {
      const guard = makeGuard();
      const valueFromAttacker = signCookieValue(
        { userId: 'u_attacker', issuedAt: Date.now() },
        'totally-different-secret-32-chars-long',
      );
      const req: FakeReq = {
        headers: {
          cookie: buildCookieHeader(SESSION_COOKIE_NAME, valueFromAttacker),
        },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when the payload is missing userId', () => {
      // A correctly-signed payload that lacks the `userId` field — the
      // guard's payload validation must reject it instead of attaching
      // `req.user.id = undefined`.
      const guard = makeGuard();
      const value = signCookieValue({ issuedAt: Date.now() }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when userId is the wrong type (number)', () => {
      const guard = makeGuard();
      const value = signCookieValue({ userId: 12345, issuedAt: Date.now() }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when userId is an empty string', () => {
      const guard = makeGuard();
      const value = signCookieValue({ userId: '', issuedAt: Date.now() }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when xr_session value is structurally invalid', () => {
      // No dot at all → not even a candidate for signCookieValue's
      // shape.
      const guard = makeGuard();
      const req: FakeReq = {
        headers: {
          cookie: buildCookieHeader(SESSION_COOKIE_NAME, 'not-a-signed-cookie-at-all'),
        },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });
  });
});
