import { describe, expect, it } from 'bun:test';
import { AuthExpiredError } from '../auth/auth.service';
import type { UserRecord, UsersRepo } from '../users/users.repo';
import {
  type FakeAuthService,
  XApiV2Source,
  type XApiV2SourceConfig,
} from './x-api-v2.source';

/**
 * Shared config — the real `AuthModule` passes the same three endpoint
 * strings; centralising them here so each test case stays focused on the
 * actual behaviour under test.
 */
const baseConfig: XApiV2SourceConfig = {
  baseUrl: 'https://api.twitter.com',
  fetchTimeoutMs: 10_000,
};

/**
 * Build a `UsersRepo`-shaped fake that only implements `findById`. The
 * adapter never calls anything else, and the structural type keeps the
 * test from depending on the rest of the repo surface.
 */
function fakeUsersRepo(user: UserRecord | null): Pick<UsersRepo, 'findById'> {
  return {
    findById: async (id: string) => {
      if (!user || user.id !== id) return null;
      return user;
    },
  };
}

/**
 * Build an `AuthService`-shaped fake that returns a fixed token, or
 * throws the provided error on every call. Matches the shape the
 * adapter actually depends on (not the full concrete class) so we don't
 * have to stand up the whole crypto/repo pipeline for a network test.
 */
function fakeAuthService(opts: {
  token?: string;
  throwOnGet?: Error;
}): FakeAuthService {
  return {
    getValidAccessToken: async (_userId: string) => {
      if (opts.throwOnGet) throw opts.throwOnGet;
      return opts.token ?? 'access-token-xyz';
    },
  };
}

interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Queue-backed fetch fake — pops one response per call. If the queue
 * runs dry the test fails loudly (instead of returning `undefined` and
 * crashing with a confusing TypeError later).
 */
function fakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[i++];
    if (!r) throw new Error('fakeFetch: no more responses queued');
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const activeUser: UserRecord = {
  id: 'appwrite-user-1',
  xUserId: '123456',
  handle: 'alice',
  status: 'active',
  createdAt: '2026-04-01T00:00:00.000Z',
};

describe('XApiV2Source.fetchLikes — happy path', () => {
  it('calls the correct liked_tweets endpoint with bearer auth and parses the response', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          data: [
            {
              id: 'tweet-1',
              text: 'hello https://example.com/a',
              author_id: 'x-author-1',
              entities: {
                urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/a' }],
              },
            },
            {
              id: 'tweet-2',
              text: 'plain text no links',
              author_id: 'x-author-2',
            },
          ],
          includes: {
            users: [
              { id: 'x-author-1', username: 'bob' },
              { id: 'x-author-2', username: 'carol' },
            ],
          },
          meta: {},
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({ token: 'my-access-token' }),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );

    const page = await source.fetchLikes('appwrite-user-1');

    // URL shape check — path plus expected query fields.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('fetchLikes made no HTTP call');
    const called = new URL(call.url);
    expect(called.origin + called.pathname).toBe(
      'https://api.twitter.com/2/users/123456/liked_tweets',
    );
    expect(called.searchParams.get('tweet.fields')).toBe('entities,author_id,text');
    expect(called.searchParams.get('user.fields')).toBe('username');
    expect(called.searchParams.get('max_results')).toBe('100');
    // No cursor → no pagination_token param.
    expect(called.searchParams.has('pagination_token')).toBe(false);

    // Bearer header check — must be the plaintext token from AuthService.
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer my-access-token');
    expect(headers.get('accept')).toBe('application/json');

    // Mapping check — both tweets should be stamped with kind='like'.
    expect(page.items).toEqual([
      {
        tweetId: 'tweet-1',
        text: 'hello https://example.com/a',
        authorHandle: 'bob',
        urls: ['https://example.com/a'],
        kind: 'like',
      },
      {
        tweetId: 'tweet-2',
        text: 'plain text no links',
        authorHandle: 'carol',
        urls: [],
        kind: 'like',
      },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns empty items when X returns an empty data array', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 200, body: { data: [], meta: {} } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('falls back to empty authorHandle when includes.users is missing for an author_id', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      {
        status: 200,
        body: {
          data: [
            {
              id: 'tweet-orphan',
              text: 'orphan tweet',
              author_id: 'x-missing',
            },
          ],
          includes: { users: [] },
          meta: {},
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.authorHandle).toBe('');
  });

  it('falls back to empty authorHandle when includes is entirely absent', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      {
        status: 200,
        body: {
          data: [
            { id: 'tweet-x', text: 'no includes at all', author_id: 'x-author' },
          ],
          meta: {},
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.items[0]?.authorHandle).toBe('');
  });

  it('tolerates a tweet with no author_id (sets authorHandle to empty string)', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ id: 'tweet-y', text: 'anonymous' }],
          includes: { users: [{ id: 'someone', username: 'someone' }] },
          meta: {},
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.items[0]?.authorHandle).toBe('');
  });
});

describe('XApiV2Source.fetchBookmarks — happy path', () => {
  it('calls the correct bookmarks endpoint and stamps kind=bookmark', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ id: 'bm-1', text: 'bookmarked', author_id: 'a1' }],
          includes: { users: [{ id: 'a1', username: 'dave' }] },
          meta: {},
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchBookmarks('appwrite-user-1');

    const call = calls[0];
    if (!call) throw new Error('fetchBookmarks made no HTTP call');
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(
      'https://api.twitter.com/2/users/123456/bookmarks',
    );
    expect(page.items).toEqual([
      {
        tweetId: 'bm-1',
        text: 'bookmarked',
        authorHandle: 'dave',
        urls: [],
        kind: 'bookmark',
      },
    ]);
  });
});

describe('XApiV2Source — cursor handling', () => {
  it('passes the provided cursor through as pagination_token', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([
      { status: 200, body: { data: [], meta: {} } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    await source.fetchLikes('appwrite-user-1', 'cursor-from-previous-page');
    const call = calls[0];
    if (!call) throw new Error('fetchLikes made no HTTP call');
    const url = new URL(call.url);
    expect(url.searchParams.get('pagination_token')).toBe('cursor-from-previous-page');
  });

  it('returns meta.next_token as nextCursor when present', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      {
        status: 200,
        body: {
          data: [{ id: 't', text: 'body', author_id: 'x' }],
          includes: { users: [{ id: 'x', username: 'e' }] },
          meta: { next_token: 'pg-2' },
        },
      },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.nextCursor).toBe('pg-2');
  });

  it('returns undefined nextCursor when meta.next_token is absent', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 200, body: { data: [], meta: {} } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchBookmarks('appwrite-user-1');
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns undefined nextCursor when meta is absent entirely', async () => {
    const { fetch: fakeImpl } = fakeFetch([{ status: 200, body: { data: [] } }]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    const page = await source.fetchLikes('appwrite-user-1');
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('XApiV2Source — auth propagation', () => {
  it('propagates AuthExpiredError from AuthService without touching fetch', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({
        throwOnGet: new AuthExpiredError('no tokens stored for user appwrite-user-1'),
      }),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    await expect(source.fetchLikes('appwrite-user-1')).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('XApiV2Source — user resolution', () => {
  it('throws when the user row is not found', async () => {
    const { fetch: fakeImpl, calls } = fakeFetch([]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(null),
      fakeImpl,
    );
    await expect(source.fetchLikes('missing-user')).rejects.toThrow(/missing-user/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the user is not active', async () => {
    const pausedUser: UserRecord = { ...activeUser, status: 'paused' };
    const { fetch: fakeImpl, calls } = fakeFetch([]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(pausedUser),
      fakeImpl,
    );
    await expect(source.fetchLikes('appwrite-user-1')).rejects.toThrow(/paused/);
    expect(calls).toHaveLength(0);
  });
});

describe('XApiV2Source — upstream failures', () => {
  it('throws with status + truncated body on a non-2xx response', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 429, body: { title: 'Too Many Requests', detail: 'rate limited' } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({ token: 'should-not-leak' }),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    try {
      await source.fetchLikes('appwrite-user-1');
      throw new Error('expected fetchLikes to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('429');
      // Defense in depth: the token must never appear in the thrown message.
      expect(msg).not.toContain('should-not-leak');
    }
  });

  it('surfaces a zod parse error when the response is missing required fields', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 200, body: { data: [{ /* missing id and text */ }] } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({}),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    await expect(source.fetchLikes('appwrite-user-1')).rejects.toThrow();
  });

  it('does not leak access tokens in the thrown message for a zod parse error', async () => {
    const { fetch: fakeImpl } = fakeFetch([
      { status: 200, body: { data: [{}] } },
    ]);
    const source = new XApiV2Source(
      baseConfig,
      fakeAuthService({ token: 'sensitive-token-value' }),
      fakeUsersRepo(activeUser),
      fakeImpl,
    );
    try {
      await source.fetchLikes('appwrite-user-1');
      throw new Error('expected fetchLikes to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('sensitive-token-value');
    }
  });
});
