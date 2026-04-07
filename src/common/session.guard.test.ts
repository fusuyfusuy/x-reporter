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
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days, matches SESSION_COOKIE_MAX_AGE_SEC

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
  return new SessionGuard({ sessionSecret: SECRET, sessionMaxAgeSec: MAX_AGE_SEC });
}

function mintSessionCookieValue(userId: string): string {
  return signCookieValue({ userId, issuedAt: Date.now() }, SECRET);
}

function buildCookieHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

/**
 * Helper: invoke the guard, expect it to throw `UnauthorizedException`,
 * and assert that the thrown exception carries the documented
 * `{ error: { code: 'unauthorized', message, details } }` envelope. All
 * 401 paths share this shape so clients see a single response schema
 * regardless of which failure path was hit.
 */
function expectUnauthorizedEnvelope(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnauthorizedException);
  const status = (caught as { getStatus?: () => number }).getStatus?.();
  expect(status).toBe(401);
  const body = (caught as { getResponse: () => unknown }).getResponse();
  expect(body).toMatchObject({
    error: { code: 'unauthorized', message: 'unauthorized', details: {} },
  });
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
    it('throws Unauthorized with the documented error envelope when there is no Cookie header at all', () => {
      const guard = makeGuard();
      const req: FakeReq = { headers: {} };
      expectUnauthorizedEnvelope(() => guard.canActivate(makeContext(req)));
      expect(req.user).toBeUndefined();
    });

    it('throws Unauthorized when the Cookie header is present but xr_session is missing', () => {
      const guard = makeGuard();
      const req: FakeReq = { headers: { cookie: 'other=foo; another=bar' } };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized with the documented envelope when the signature does not verify (tampered cookie)', () => {
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
      expectUnauthorizedEnvelope(() => guard.canActivate(makeContext(req)));
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

    it('throws Unauthorized with the documented envelope when the payload is missing userId', () => {
      // A correctly-signed payload that lacks the `userId` field — the
      // guard's payload validation must reject it instead of attaching
      // `req.user.id = undefined`. We assert the envelope here so the
      // malformed-payload branch is covered alongside the
      // missing-cookie and bad-signature branches above; together
      // those three cover every code path that throws 401.
      const guard = makeGuard();
      const value = signCookieValue({ issuedAt: Date.now() }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expectUnauthorizedEnvelope(() => guard.canActivate(makeContext(req)));
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

    it('throws Unauthorized when issuedAt is missing from the payload', () => {
      // A correctly-signed payload that lacks `issuedAt` entirely.
      // The guard cannot enforce session expiry on a cookie that
      // doesn't carry an issue time, so this must collapse to 401
      // rather than be silently accepted with no expiry.
      const guard = makeGuard();
      const value = signCookieValue({ userId: 'u_abc' }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when issuedAt is the wrong type', () => {
      const guard = makeGuard();
      const value = signCookieValue(
        { userId: 'u_abc', issuedAt: 'yesterday' },
        SECRET,
      );
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });

    it('throws Unauthorized when the session is older than sessionMaxAgeSec', () => {
      // Mint a cookie with an `issuedAt` that's exactly the configured
      // max age + 1 second in the past. The signature is valid, the
      // payload is well-formed, the only thing wrong is that the
      // session lifetime has elapsed — server-side expiry must reject
      // it instead of trusting the browser to have honored Max-Age.
      const guard = makeGuard();
      const expiredIssuedAt = Date.now() - (MAX_AGE_SEC * 1000 + 1000);
      const value = signCookieValue(
        { userId: 'u_abc', issuedAt: expiredIssuedAt },
        SECRET,
      );
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expectUnauthorizedEnvelope(() => guard.canActivate(makeContext(req)));
      expect(req.user).toBeUndefined();
    });

    it('throws Unauthorized when issuedAt is far in the future (beyond clock skew tolerance)', () => {
      // A payload claiming to be from 1 hour in the future. The 5s
      // skew tolerance allows tiny clock drift but not this — far-
      // future timestamps are either tampered or from a clock that's
      // so wrong that nothing the cookie carries is trustworthy.
      const guard = makeGuard();
      const futureIssuedAt = Date.now() + 60 * 60 * 1000;
      const value = signCookieValue(
        { userId: 'u_abc', issuedAt: futureIssuedAt },
        SECRET,
      );
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(() => guard.canActivate(makeContext(req))).toThrow(UnauthorizedException);
    });
  });

  describe('expiry edge cases', () => {
    it('accepts a session that is exactly 1 second younger than the max age', () => {
      // The boundary case: sessions within the window should still
      // work right up to the moment of expiry. Without this assertion
      // an off-by-one in the comparison (`<` vs `<=`) could quietly
      // log everyone out one tick early.
      const guard = makeGuard();
      const issuedAt = Date.now() - (MAX_AGE_SEC * 1000 - 1000);
      const value = signCookieValue({ userId: 'u_abc', issuedAt }, SECRET);
      const req: FakeReq = {
        headers: { cookie: buildCookieHeader(SESSION_COOKIE_NAME, value) },
      };
      expect(guard.canActivate(makeContext(req))).toBe(true);
      expect(req.user?.id).toBe('u_abc');
    });
  });
});
