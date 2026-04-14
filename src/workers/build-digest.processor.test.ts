import { describe, expect, it } from 'bun:test';
import type { DigestGraph, DigestInput, DigestResult } from '../digest/graph/digest.graph';
import type { UserRecord } from '../users/users.repo';
import type { ArticleRecord } from './articles.repo';
import { BuildDigestProcessor } from './build-digest.processor';
import type { CreateDigestInput, DigestRecord } from './digests.repo';
import type { ItemRecord } from './items.repo';

/**
 * Tests for the `build-digest` processor. The goal is to pin the
 * acceptance criteria from issue #11:
 *
 *   - Valid payload → enriched items loaded → graph runs → a single
 *     digests row is persisted with `markdown`, `itemIds`, `model`,
 *     `tokensIn`, `tokensOut`.
 *   - Empty window is a no-op (no row written, no throw).
 *   - Invalid user / missing / non-active user is skipped (no throw,
 *     no row).
 *   - Malformed job payload is a non-retryable skip.
 *
 * Fakes follow the pattern established in `extract-item.processor.test.ts`.
 */

class FakeUsersRepo {
  users = new Map<string, UserRecord>();
  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }
}

class FakeItemsRepo {
  items: ItemRecord[] = [];
  windowCalls: Array<{ userId: string; start: Date; end: Date }> = [];

  async findEnrichedInWindow(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<ItemRecord[]> {
    this.windowCalls.push({ userId, start, end });
    return this.items.filter(
      (i) =>
        i.userId === userId &&
        i.enriched &&
        i.fetchedAt >= start.toISOString() &&
        i.fetchedAt < end.toISOString(),
    );
  }
}

class FakeArticlesRepo {
  articles: ArticleRecord[] = [];
  async findByItemIds(itemIds: readonly string[]): Promise<ArticleRecord[]> {
    const set = new Set(itemIds);
    return this.articles.filter((a) => set.has(a.itemId));
  }
}

class FakeDigestsRepo {
  persisted: CreateDigestInput[] = [];
  async create(input: CreateDigestInput): Promise<DigestRecord> {
    this.persisted.push(input);
    return {
      id: `d-${this.persisted.length}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
  }
}

class StubGraph {
  calls: DigestInput[] = [];
  result: DigestResult = {
    markdown: '## digest\n',
    itemIds: [],
    usage: { tokensIn: 123, tokensOut: 45 },
    model: 'anthropic/claude-sonnet-4.5',
  };

  async run(input: DigestInput): Promise<DigestResult> {
    this.calls.push(input);
    // Reflect the input item ids in the result so the processor can
    // persist them — mirrors the real `DigestGraph.run` behavior.
    return { ...this.result, itemIds: input.items.map((i) => i.id) };
  }
}

class FakeLogger {
  logs: Array<{ level: string; msg: string }> = [];
  log(msg: string) {
    this.logs.push({ level: 'log', msg });
  }
  warn(msg: string) {
    this.logs.push({ level: 'warn', msg });
  }
}

function makeItem(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: 'item-1',
    userId: 'u1',
    xTweetId: 't1',
    kind: 'like',
    text: 'check this',
    authorHandle: 'alice',
    urls: ['https://a.test'],
    fetchedAt: new Date().toISOString(),
    enriched: true,
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u1',
    xUserId: '12345',
    handle: 'alice',
    status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    digestIntervalMin: 60,
    ...overrides,
  };
}

function makeProcessor() {
  const users = new FakeUsersRepo();
  const items = new FakeItemsRepo();
  const articles = new FakeArticlesRepo();
  const digests = new FakeDigestsRepo();
  const graph = new StubGraph();
  const logger = new FakeLogger();
  const processor = new BuildDigestProcessor(
    users as never,
    items as never,
    articles as never,
    digests as never,
    graph as unknown as DigestGraph,
  );
  Object.defineProperty(processor, 'logger', { value: logger });
  return { processor, users, items, articles, digests, graph, logger };
}

describe('BuildDigestProcessor.process', () => {
  it('loads enriched items + articles, runs the graph, and persists one digest row', async () => {
    const { processor, users, items, articles, digests, graph } = makeProcessor();
    users.users.set('u1', makeUser());
    const now = Date.now();
    items.items.push(
      makeItem({ id: 'i1', fetchedAt: new Date(now - 30 * 60_000).toISOString() }),
      makeItem({ id: 'i2', fetchedAt: new Date(now - 10 * 60_000).toISOString() }),
    );
    articles.articles.push({
      id: 'a1',
      itemId: 'i1',
      url: 'https://a.test',
      content: 'body',
      extractedAt: new Date().toISOString(),
      extractor: 'firecrawl',
      title: 'A',
    });

    await processor.process({
      data: { userId: 'u1' },
      attemptsMade: 0,
    });

    expect(graph.calls).toHaveLength(1);
    const call = graph.calls[0]!;
    expect(call.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(call.items[0]!.articles[0]).toEqual({
      url: 'https://a.test',
      content: 'body',
      title: 'A',
    });

    expect(digests.persisted).toHaveLength(1);
    const row = digests.persisted[0]!;
    expect(row.userId).toBe('u1');
    expect(row.markdown).toBe('## digest\n');
    expect(row.itemIds).toEqual(['i1', 'i2']);
    expect(row.model).toBe('anthropic/claude-sonnet-4.5');
    expect(row.tokensIn).toBe(123);
    expect(row.tokensOut).toBe(45);
    expect(typeof row.windowStart).toBe('string');
    expect(typeof row.windowEnd).toBe('string');
  });

  it('is a no-op when the window has zero enriched items', async () => {
    const { processor, users, digests, graph } = makeProcessor();
    users.users.set('u1', makeUser());

    await processor.process({
      data: { userId: 'u1' },
      attemptsMade: 0,
    });

    expect(graph.calls).toHaveLength(0);
    expect(digests.persisted).toHaveLength(0);
  });

  it('skips users not found', async () => {
    const { processor, digests, graph } = makeProcessor();

    await processor.process({
      data: { userId: 'ghost' },
      attemptsMade: 0,
    });

    expect(graph.calls).toHaveLength(0);
    expect(digests.persisted).toHaveLength(0);
  });

  it('skips users not active (auth_expired / paused)', async () => {
    const { processor, users, digests, graph } = makeProcessor();
    users.users.set('u1', makeUser({ status: 'auth_expired' }));

    await processor.process({
      data: { userId: 'u1' },
      attemptsMade: 0,
    });

    expect(graph.calls).toHaveLength(0);
    expect(digests.persisted).toHaveLength(0);
  });

  it('uses job-supplied windowStart and windowEnd when provided', async () => {
    const { processor, users, items, digests, graph } = makeProcessor();
    users.users.set('u1', makeUser());
    const windowStart = '2026-04-05T00:00:00.000Z';
    const windowEnd = '2026-04-06T00:00:00.000Z';
    items.items.push(
      makeItem({ id: 'i1', fetchedAt: '2026-04-05T12:00:00.000Z' }),
    );

    await processor.process({
      data: { userId: 'u1', windowStart, windowEnd },
      attemptsMade: 0,
    });

    expect(graph.calls[0]!.window.start.toISOString()).toBe(windowStart);
    expect(graph.calls[0]!.window.end.toISOString()).toBe(windowEnd);
    expect(digests.persisted[0]!.windowStart).toBe(windowStart);
    expect(digests.persisted[0]!.windowEnd).toBe(windowEnd);
  });

  it('falls back to the user cadence interval when windows are absent', async () => {
    const { processor, users, items, graph } = makeProcessor();
    users.users.set('u1', makeUser({ digestIntervalMin: 1440 }));
    // Seed an item clearly inside a 24h window so the processor
    // reaches the graph call — without a matching item the no-op
    // branch returns before `graph.calls` is populated.
    items.items.push(
      makeItem({
        id: 'i1',
        fetchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );

    await processor.process({
      data: { userId: 'u1' },
      attemptsMade: 0,
    });

    const { start, end } = graph.calls[0]!.window;
    const spanMs = end.getTime() - start.getTime();
    expect(spanMs).toBe(1440 * 60_000);
  });

  it('returns without throwing on malformed payloads (no retry)', async () => {
    const { processor, digests, graph, logger } = makeProcessor();

    await processor.process({ data: {}, attemptsMade: 0 });
    await processor.process({ data: null, attemptsMade: 0 });
    await processor.process({ data: { userId: '' }, attemptsMade: 0 });
    await processor.process({
      data: { userId: 'u1', windowStart: 'not-a-date' },
      attemptsMade: 0,
    });

    expect(graph.calls).toHaveLength(0);
    expect(digests.persisted).toHaveLength(0);
    expect(
      logger.logs.filter(
        (l) => l.level === 'warn' && l.msg.includes('invalid job payload'),
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('does not persist when the graph throws (so BullMQ retries)', async () => {
    const { processor, users, items, digests, graph } = makeProcessor();
    users.users.set('u1', makeUser());
    items.items.push(
      makeItem({
        fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    graph.run = async () => {
      throw new Error('graph boom');
    };

    await expect(
      processor.process({ data: { userId: 'u1' }, attemptsMade: 0 }),
    ).rejects.toThrow('graph boom');
    expect(digests.persisted).toHaveLength(0);
  });
});
