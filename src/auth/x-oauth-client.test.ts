import { describe, expect, it } from 'bun:test';
import {
  HttpXOAuthClient,
  type XOAuthClientConfig,
  XTokenResponseSchema,
} from './x-oauth-client';

const baseConfig: XOAuthClientConfig = {
  clientId: 'client-id-123',
  clientSecret: 'client-secret-456',
  redirectUri: 'http://localhost:3000/auth/x/callback',
  scopes: 'tweet.read users.read offline.access',
  authorizeEndpoint: 'https://twitter.com/i/oauth2/authorize',
  tokenEndpoint: 'https://api.twitter.com/2/oauth2/token',
  userInfoEndpoint: 'https://api.twitter.com/2/users/me',
};

interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[i++];
    if (!r) throw new Error('fakeFetch: no more responses queued');
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('HttpXOAuthClient.buildAuthorizeUrl', () => {
  it('produces an authorize URL with all required PKCE query params', () => {
    const client = new HttpXOAuthClient(baseConfig, fetch);
    const url = new URL(
      client.buildAuthorizeUrl({ state: 'state-abc', codeChallenge: 'chal-xyz' }),
    );
    expect(url.origin + url.pathname).toBe('https://twitter.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-id-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/x/callback',
    );
    expect(url.searchParams.get('scope')).toBe('tweet.read users.read offline.access');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge')).toBe('chal-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('HttpXOAuthClient.exchangeCode', () => {
  it('POSTs form-encoded body with grant_type=authorization_code and basic auth', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          token_type: 'bearer',
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 7200,
          scope: 'tweet.read users.read offline.access',
        },
      },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    const result = await client.exchangeCode({
      code: 'authcode-1',
      codeVerifier: 'verifier-1',
    });

    expect(result.accessToken).toBe('access-1');
    expect(result.refreshToken).toBe('refresh-1');
    expect(result.expiresIn).toBe(7200);
    expect(result.scope).toBe('tweet.read users.read offline.access');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.twitter.com/2/oauth2/token');
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    // Basic auth: base64("client-id-123:client-secret-456")
    const expectedAuth = `Basic ${Buffer.from('client-id-123:client-secret-456').toString('base64')}`;
    expect(headers.get('authorization')).toBe(expectedAuth);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('authcode-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('redirect_uri')).toBe('http://localhost:3000/auth/x/callback');
    expect(body.get('client_id')).toBe('client-id-123');
  });

  it('throws when X returns a non-2xx response', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 400, body: { error: 'invalid_request' } },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    await expect(
      client.exchangeCode({ code: 'bad', codeVerifier: 'v' }),
    ).rejects.toThrow(/x oauth/i);
  });

  it('throws when the response body fails schema validation', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 200, body: { not: 'a token response' } },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    await expect(
      client.exchangeCode({ code: 'c', codeVerifier: 'v' }),
    ).rejects.toThrow();
  });
});

describe('HttpXOAuthClient.refresh', () => {
  it('POSTs form-encoded body with grant_type=refresh_token and basic auth', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          token_type: 'bearer',
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 7200,
          scope: 'tweet.read offline.access',
        },
      },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    const result = await client.refresh('old-refresh-token');
    expect(result.accessToken).toBe('access-2');
    expect(result.refreshToken).toBe('refresh-2');

    const init = calls[0]!.init!;
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
    expect(body.get('client_id')).toBe('client-id-123');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toContain('Basic ');
  });

  it('falls back to the existing refresh_token when X omits it from the response', async () => {
    // RFC 6749 §6 makes the refresh_token field OPTIONAL on the refresh
    // response — the server may omit it when the existing token is still
    // valid. The client must reuse the previous refresh token in that
    // case rather than rejecting the response or losing the token.
    const { fetch: fakeImpl } = fakeFetch([
      {
        status: 200,
        body: {
          token_type: 'bearer',
          access_token: 'access-rotated',
          // no refresh_token field
          expires_in: 7200,
          scope: 'tweet.read offline.access',
        },
      },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    const result = await client.refresh('previous-refresh-token');
    expect(result.accessToken).toBe('access-rotated');
    expect(result.refreshToken).toBe('previous-refresh-token');
  });

  it('throws when refresh is rejected by X', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 401, body: { error: 'invalid_grant' } },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    await expect(client.refresh('expired')).rejects.toThrow(/x oauth/i);
  });
});

describe('HttpXOAuthClient.getMe', () => {
  it('GETs /2/users/me with a bearer token and returns id + username', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      { status: 200, body: { data: { id: '12345', username: 'fusuyfusuy' } } },
    ]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    const me = await client.getMe('the-access-token');
    expect(me.xUserId).toBe('12345');
    expect(me.handle).toBe('fusuyfusuy');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.twitter.com/2/users/me');
    const init = calls[0]!.init!;
    expect(init.method).toBe('GET');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer the-access-token');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('throws when X returns a non-2xx response', async () => {
    const { fetch: fakeImpl } = fakeFetch([{ status: 401, body: { error: 'unauthenticated' } }]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    await expect(client.getMe('bad-token')).rejects.toThrow(/x users\/me/i);
  });

  it('throws when the response body fails schema validation', async () => {
    const { fetch: fakeImpl } = fakeFetch([{ status: 200, body: { not: 'a user response' } }]);
    const client = new HttpXOAuthClient(baseConfig, fakeImpl);
    await expect(client.getMe('t')).rejects.toThrow();
  });
});

describe('HttpXOAuthClient fetch timeout', () => {
  it('aborts and throws a timeout error when the underlying fetch hangs past fetchTimeoutMs', async () => {
    // A fetch impl that observes the abort signal and rejects with the
    // standard AbortError when the controller fires.
    const hangingFetch = ((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const client = new HttpXOAuthClient(
      { ...baseConfig, fetchTimeoutMs: 20 },
      hangingFetch,
    );
    await expect(client.getMe('any-token')).rejects.toThrow(/timed out/i);
  });

  it('aborts when the response headers arrive but the body stalls past fetchTimeoutMs', async () => {
    // Simulate a server that flushes headers immediately (so `fetch()`
    // resolves with a Response) but never finishes streaming the body.
    // The timeout scope must cover `res.json()` too — without that,
    // `clearTimeout` would fire on the headers and the body read would
    // hang forever.
    const stallingBodyFetch = ((_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(_controller) {
          // Never enqueue, never close. The signal hookup below is the
          // only way this stream becomes done.
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            _controller.error(err);
          });
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new HttpXOAuthClient(
      { ...baseConfig, fetchTimeoutMs: 20 },
      stallingBodyFetch,
    );
    await expect(client.getMe('any-token')).rejects.toThrow(/timed out/i);
  });
});

describe('XTokenResponseSchema', () => {
  it('accepts a valid response', () => {
    const parsed = XTokenResponseSchema.parse({
      token_type: 'bearer',
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 7200,
      scope: 's',
    });
    expect(parsed.access_token).toBe('a');
  });

  it('rejects a response missing access_token', () => {
    expect(() =>
      XTokenResponseSchema.parse({
        token_type: 'bearer',
        refresh_token: 'r',
        expires_in: 7200,
        scope: 's',
      }),
    ).toThrow();
  });
});
