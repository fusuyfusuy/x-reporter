import { describe, expect, it } from 'bun:test';
import { AuthExpiredError } from '../auth/auth.service';
import type { FetchPage, TweetItem, XSource } from '../ingestion/x-source.port';
import type { UserRecord } from '../users/users.repo';
import { PollXProcessor } from './poll-x.processor';

class StubXSource implements XSource {
  likePages: FetchPage[] = [];
  bookmarkPages: FetchPage[] = [];
  private likeCallIndex = 0;
  private bookmarkCallIndex = 0;

  async fetchLikes(_userId: string, _cursor?: string): Promise<FetchPage> {
    return this.likePages[this.likeCallIndex++] ?? { items: [] };
  }

  async fetchBookmarks(_userId: string, _cursor?: string): Promise<FetchPage> {
    return this.bookmarkPages[this.bookmarkCallIndex++] ?? { items: [] };
  }
}

class FakeUsersRepo {
  users = new Map<string, UserRecord>();
  cursorUpdates: Array<{ userId: string; cursors: Record<string, string> }> = [];

  async findById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async updateCursors(
    userId: string,
    cursors: { lastLikeCursor?: string; lastBookmarkCursor?: string },
  ): Promise<UserRecord> {
    this.cursorUpdates.push({ userId, cursors: cursors as Record<string, string> });
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    return { ...user, ...cursors };
  }
}

class FakeItemsRepo {
  upserted: Array<{ userId: string; items: TweetItem[] }> = [];
  private nextId = 1;
  knownTweetIds = new Set<string>();

  async upsertMany(
    userId: string,
    items: TweetItem[],
  ): Promise<Array<{ id: string; isNew: boolean }>> {
    this.upserted.push({ userId, items: [...items] });
    return items.map((item) => {
      const key = `${userId}:${item.tweetId}`;
      const isNew = !this.knownTweetIds.has(key);
      this.knownTweetIds.add(key);
      return { id: `item-${this.nextId++}`, isNew };
    });
  }
}

class FakeExtractQueue {
  jobs: Array<{ name: string; data: unknown }> = [];

  async add(name: string, data: unknown): Promise<void> {
    this.jobs.push({ name, data });
  }
}

class FakeLogger {
  logs: Array<{ level: string; msg: string; context?: Record<string, unknown> }> = [];

  log(msg: string, context?: Record<string, unknown>) {
    this.logs.push({ level: 'log', msg, context });
  }

  warn(msg: string, context?: Record<string, unknown>) {
    this.logs.push({ level: 'warn', msg, context });
  }
}

function activeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    xUserId: '99999',
    handle: 'testuser',
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTweet(overrides: Partial<TweetItem> = {}): TweetItem {
  return {
    tweetId: 'tw-1',
    text: 'check this out',
    authorHandle: 'author1',
    urls: ['https://example.com/article'],
    kind: 'like',
    ...overrides,
  };
}

function makeProcessor() {
  const xSource = new StubXSource();
  const users = new FakeUsersRepo();
  const items = new FakeItemsRepo();
  const extractQueue = new FakeExtractQueue();
  const logger = new FakeLogger();

  const processor = new PollXProcessor(
    xSource,
    extractQueue as never,
    users as never,
    items as never,
  );

  // Replace the logger that NestJS auto-creates.
  Object.defineProperty(processor, 'logger', { value: logger });

  return { processor, xSource, users, items, extractQueue, logger };
}

describe('PollXProcessor.process', () => {
  it('fetches likes and bookmarks, upserts items, updates cursors, enqueues extraction', async () => {
    const { processor, xSource, users, items, extractQueue } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    xSource.likePages = [
      { items: [makeTweet({ tweetId: 'tw-1', kind: 'like' })], nextCursor: 'lc1' },
      { items: [makeTweet({ tweetId: 'tw-2', kind: 'like' })] },
    ];
    xSource.bookmarkPages = [
      { items: [makeTweet({ tweetId: 'tw-3', kind: 'bookmark', urls: [] })] },
    ];

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    // Items upserted: likes batch + bookmarks batch.
    expect(items.upserted).toHaveLength(2);
    expect(items.upserted[0]!.items).toHaveLength(2);
    expect(items.upserted[1]!.items).toHaveLength(1);

    // Extract jobs enqueued only for items with URLs (tw-1 and tw-2, not tw-3).
    expect(extractQueue.jobs).toHaveLength(2);
    expect(extractQueue.jobs[0]!.data).toEqual({ userId: user.id, itemId: 'item-1' });
    expect(extractQueue.jobs[1]!.data).toEqual({ userId: user.id, itemId: 'item-2' });
  });

  it('skips extract-item enqueue for items without URLs', async () => {
    const { processor, xSource, users, extractQueue } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    xSource.likePages = [
      { items: [makeTweet({ tweetId: 'tw-1', urls: [] })] },
    ];
    xSource.bookmarkPages = [{ items: [] }];

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(extractQueue.jobs).toHaveLength(0);
  });

  it('updates cursors with the final pagination cursor', async () => {
    const { processor, xSource, users } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    xSource.likePages = [
      { items: [makeTweet()], nextCursor: 'lc1' },
      { items: [], nextCursor: 'lc2' },
      { items: [] },
    ];
    xSource.bookmarkPages = [
      { items: [], nextCursor: 'bc1' },
      { items: [] },
    ];

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(users.cursorUpdates).toHaveLength(1);
    expect(users.cursorUpdates[0]!.cursors).toEqual({
      lastLikeCursor: 'lc2',
      lastBookmarkCursor: 'bc1',
    });
  });

  it('returns early without retry when user is missing', async () => {
    const { processor, items, extractQueue } = makeProcessor();

    await processor.process({ data: { userId: 'gone' }, attemptsMade: 0 });

    expect(items.upserted).toHaveLength(0);
    expect(extractQueue.jobs).toHaveLength(0);
  });

  it('returns early without retry when user status is not active', async () => {
    const { processor, users, items } = makeProcessor();
    const user = activeUser({ status: 'auth_expired' });
    users.users.set(user.id, user);

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(items.upserted).toHaveLength(0);
  });

  it('catches AuthExpiredError and returns without throwing', async () => {
    const { processor, xSource, users, items } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    xSource.fetchLikes = async () => {
      throw new AuthExpiredError('refresh failed');
    };

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(items.upserted).toHaveLength(0);
  });

  it('lets transport errors propagate for BullMQ retry', async () => {
    const { processor, xSource, users } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    xSource.fetchLikes = async () => {
      throw new Error('x api v2 request timed out');
    };

    await expect(
      processor.process({ data: { userId: user.id }, attemptsMade: 0 }),
    ).rejects.toThrow('x api v2 request timed out');
  });

  it('passes stored cursors into XSource calls', async () => {
    const { processor, xSource, users } = makeProcessor();
    const user = activeUser({
      lastLikeCursor: 'stored-lc',
      lastBookmarkCursor: 'stored-bc',
    });
    users.users.set(user.id, user);

    const likeCursors: Array<string | undefined> = [];
    const bookmarkCursors: Array<string | undefined> = [];

    xSource.fetchLikes = async (_userId: string, cursor?: string) => {
      likeCursors.push(cursor);
      return { items: [] };
    };
    xSource.fetchBookmarks = async (_userId: string, cursor?: string) => {
      bookmarkCursors.push(cursor);
      return { items: [] };
    };

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(likeCursors[0]).toBe('stored-lc');
    expect(bookmarkCursors[0]).toBe('stored-bc');
  });

  it('only enqueues extract-item for NEW items, not duplicates', async () => {
    const { processor, xSource, users, items, extractQueue } = makeProcessor();
    const user = activeUser();
    users.users.set(user.id, user);

    items.knownTweetIds.add(`${user.id}:tw-1`);

    xSource.likePages = [
      {
        items: [
          makeTweet({ tweetId: 'tw-1', urls: ['https://a.com'] }),
          makeTweet({ tweetId: 'tw-2', urls: ['https://b.com'] }),
        ],
      },
    ];
    xSource.bookmarkPages = [{ items: [] }];

    await processor.process({ data: { userId: user.id }, attemptsMade: 0 });

    expect(extractQueue.jobs).toHaveLength(1);
    expect((extractQueue.jobs[0]!.data as { itemId: string }).itemId).toBe('item-2');
  });
});
