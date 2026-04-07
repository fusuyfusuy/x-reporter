import { describe, expect, it } from 'bun:test';
import { AuthController } from './auth.controller';
import { type AuthService, InvalidAuthCallbackError } from './auth.service';

interface FakeRes {
  _status?: number;
  _headers: Map<string, string | string[]>;
  _body?: unknown;
  _redirectedTo?: string;
  setHeader(name: string, value: string | string[]): FakeRes;
  getHeader(name: string): string | string[] | undefined;
  status(code: number): FakeRes;
  redirect(arg1: number | string, arg2?: string): FakeRes;
  send(body: unknown): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const headers = new Map<string, string | string[]>();
  // biome-ignore lint/suspicious/noExplicitAny: test stub built incrementally
  const res: any = {
    _headers: headers,
    setHeader(name: string, value: string | string[]) {
      const lower = name.toLowerCase();
      if (lower === 'set-cookie') {
        const existing = headers.get('set-cookie');
        const next = Array.isArray(existing)
          ? existing.concat(Array.isArray(value) ? value : [value])
          : Array.isArray(value)
            ? value
            : [value];
        headers.set('set-cookie', next);
      } else {
        headers.set(lower, value);
      }
      return res;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    redirect(arg1: number | string, arg2?: string) {
      if (typeof arg1 === 'number') {
        res._status = arg1;
        res._redirectedTo = arg2;
      } else {
        res._status = res._status ?? 302;
        res._redirectedTo = arg1;
      }
      return res;
    },
    send(body: unknown) {
      res._body = body;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as FakeRes;
}

interface FakeReq {
  query: Record<string, unknown>;
  headers: { cookie?: string | undefined } & Record<string, unknown>;
}

function fakeReq(opts: {
  query?: Record<string, string>;
  cookieHeader?: string;
}): FakeReq {
  return {
    query: opts.query ?? {},
    headers: { cookie: opts.cookieHeader },
  };
}

describe('AuthController', () => {
  describe('GET /auth/x/start', () => {
    it('redirects to the authorize URL and sets a state cookie', async () => {
      const fakeService: Partial<AuthService> = {
        startAuthorization: () => ({
          authorizeUrl: 'https://twitter.test/authorize?state=abc',
          stateCookieValue: 'signed.cookie.value',
        }),
      };
      const controller = new AuthController(
        fakeService as AuthService,
        { cookieSecure: false, stateCookieMaxAgeSec: 600, sessionCookieMaxAgeSec: 100 },
      );
      const res = fakeRes();
      controller.start(res);
      expect(res._status).toBe(302);
      expect(res._redirectedTo).toBe('https://twitter.test/authorize?state=abc');
      const setCookie = res._headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
      expect(cookieStr).toContain('xr_oauth_state=signed.cookie.value');
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Lax');
      expect(cookieStr).toContain('Max-Age=600');
    });
  });

  describe('GET /auth/x/callback', () => {
    it('redirects to /me and sets a session cookie on the happy path', async () => {
      const fakeService: Partial<AuthService> = {
        // biome-ignore lint/suspicious/noExplicitAny: spy
        handleCallback: (async (input: any) => {
          expect(input.code).toBe('ac');
          expect(input.state).toBe('s1');
          expect(input.stateCookieValue).toBe('signed-state');
          return {
            userId: 'u_123',
            sessionCookieValue: 'signed-session',
          };
          // biome-ignore lint/suspicious/noExplicitAny: spy
        }) as any,
      };
      const controller = new AuthController(
        fakeService as AuthService,
        { cookieSecure: false, stateCookieMaxAgeSec: 600, sessionCookieMaxAgeSec: 100 },
      );
      const req = fakeReq({
        query: { code: 'ac', state: 's1' },
        cookieHeader: 'xr_oauth_state=signed-state',
      });
      const res = fakeRes();
      await controller.callback(req, res);
      expect(res._status).toBe(302);
      expect(res._redirectedTo).toBe('/me');

      const cookies = res._headers.get('set-cookie') as string[];
      expect(Array.isArray(cookies)).toBe(true);
      // One cookie clears xr_oauth_state, one sets xr_session.
      const session = cookies.find((c) => c.startsWith('xr_session='))!;
      expect(session).toBeDefined();
      expect(session).toContain('xr_session=signed-session');
      expect(session).toContain('Max-Age=100');
      expect(session).toContain('HttpOnly');
      const cleared = cookies.find((c) => c.startsWith('xr_oauth_state='))!;
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    });

    /**
     * Build a fake AuthService whose handleCallback records every call.
     * Used by the fast-fail tests below to assert the controller short-
     * circuits *before* invoking the service — a regression where the
     * controller forwarded malformed input to handleCallback would
     * otherwise still pass if the catch-all swallowed the resulting throw.
     */
    function spyService(): {
      service: AuthService;
      calls: Array<unknown>;
    } {
      const calls: unknown[] = [];
      const service = {
        // biome-ignore lint/suspicious/noExplicitAny: spy
        handleCallback: (async (input: any) => {
          calls.push(input);
          throw new Error('should not be called');
          // biome-ignore lint/suspicious/noExplicitAny: spy
        }) as any,
      } as unknown as AuthService;
      return { service, calls };
    }

    function clearedStateCookie(res: FakeRes): string | undefined {
      const cookies = res._headers.get('set-cookie');
      if (!cookies) return undefined;
      const list = Array.isArray(cookies) ? cookies : [cookies];
      return list.find((c) => c.startsWith('xr_oauth_state='));
    }

    it('returns 400 when the query lacks required params, without invoking the service', async () => {
      const { service, calls } = spyService();
      const controller = new AuthController(service, {
        cookieSecure: false,
        stateCookieMaxAgeSec: 600,
        sessionCookieMaxAgeSec: 100,
      });
      const req = fakeReq({ query: {}, cookieHeader: 'xr_oauth_state=abc' });
      const res = fakeRes();
      await controller.callback(req, res);
      expect(res._status).toBe(400);
      expect(calls).toHaveLength(0);
      const cleared = clearedStateCookie(res);
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    });

    it('returns 400 when the state cookie is missing, without invoking the service', async () => {
      const { service, calls } = spyService();
      const controller = new AuthController(service, {
        cookieSecure: false,
        stateCookieMaxAgeSec: 600,
        sessionCookieMaxAgeSec: 100,
      });
      const req = fakeReq({ query: { code: 'c', state: 's' }, cookieHeader: undefined });
      const res = fakeRes();
      await controller.callback(req, res);
      expect(res._status).toBe(400);
      expect(calls).toHaveLength(0);
      const cleared = clearedStateCookie(res);
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    });

    it('returns 400 when AuthService rejects state mismatch', async () => {
      const fakeService = {
        handleCallback: async () => {
          throw new InvalidAuthCallbackError('state mismatch');
        },
      } as unknown as AuthService;
      const controller = new AuthController(fakeService, {
        cookieSecure: false,
        stateCookieMaxAgeSec: 600,
        sessionCookieMaxAgeSec: 100,
      });
      const req = fakeReq({
        query: { code: 'c', state: 's' },
        cookieHeader: 'xr_oauth_state=abc',
      });
      const res = fakeRes();
      await controller.callback(req, res);
      expect(res._status).toBe(400);
      const cleared = clearedStateCookie(res);
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    });

    it('returns 502 when AuthService throws a non-validation error (upstream failure)', async () => {
      const fakeService = {
        handleCallback: async () => {
          throw new Error('x oauth token endpoint failed: 503 service unavailable');
        },
      } as unknown as AuthService;
      const controller = new AuthController(fakeService, {
        cookieSecure: false,
        stateCookieMaxAgeSec: 600,
        sessionCookieMaxAgeSec: 100,
      });
      const req = fakeReq({
        query: { code: 'c', state: 's' },
        cookieHeader: 'xr_oauth_state=abc',
      });
      const res = fakeRes();
      await controller.callback(req, res);
      expect(res._status).toBe(502);
      const cleared = clearedStateCookie(res);
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Max-Age=0');
    });
  });
});
