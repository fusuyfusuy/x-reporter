import { describe, expect, it } from 'bun:test';
import type { ArticleExtractor, ExtractedArticle } from '../extraction/article-extractor.port';
import { ExtractItemProcessor } from './extract-item.processor';
import type { ItemRecord } from './items.repo';

class StubExtractor implements ArticleExtractor {
  calls: string[] = [];
  behavior: Map<string, 'ok' | 'fail'> = new Map();
  defaultBehavior: 'ok' | 'fail' = 'ok';

  async extract(url: string): Promise<ExtractedArticle> {
    this.calls.push(url);
    const mode = this.behavior.get(url) ?? this.defaultBehavior;
    if (mode === 'fail') throw new Error(`boom for ${url}`);
    return {
      url,
      content: `content for ${url}`,
      extractor: 'firecrawl',
    };
  }
}

class FakeItemsRepo {
  items = new Map<string, ItemRecord>();
  enriched: string[] = [];

  async findById(id: string): Promise<ItemRecord | null> {
    return this.items.get(id) ?? null;
  }

  async setEnriched(id: string): Promise<void> {
    this.enriched.push(id);
    const existing = this.items.get(id);
    if (existing) this.items.set(id, { ...existing, enriched: true });
  }
}

class FakeArticlesRepo {
  persisted: Array<{ itemId: string; article: ExtractedArticle }> = [];

  async create(itemId: string, article: ExtractedArticle) {
    this.persisted.push({ itemId, article });
    return {
      id: `art-${this.persisted.length}`,
      itemId,
      url: article.url,
      content: article.content,
      extractor: article.extractor,
      extractedAt: new Date().toISOString(),
    };
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
    userId: 'user-1',
    xTweetId: 'tw-1',
    kind: 'like',
    text: 'check this',
    authorHandle: 'alice',
    urls: ['https://a.test'],
    fetchedAt: new Date().toISOString(),
    enriched: false,
    ...overrides,
  };
}

function makeProcessor() {
  const extractor = new StubExtractor();
  const items = new FakeItemsRepo();
  const articles = new FakeArticlesRepo();
  const logger = new FakeLogger();
  const processor = new ExtractItemProcessor(
    extractor,
    items as never,
    articles as never,
  );
  Object.defineProperty(processor, 'logger', { value: logger });
  return { processor, extractor, items, articles, logger };
}

describe('ExtractItemProcessor.process', () => {
  it('extracts every URL, persists an article per URL, and sets enriched=true', async () => {
    const { processor, extractor, items, articles } = makeProcessor();
    const item = makeItem({ urls: ['https://a.test', 'https://b.test'] });
    items.items.set(item.id, item);

    await processor.process({
      data: { userId: item.userId, itemId: item.id },
      attemptsMade: 0,
    });

    expect(extractor.calls).toEqual(['https://a.test', 'https://b.test']);
    expect(articles.persisted).toHaveLength(2);
    expect(articles.persisted[0]!.itemId).toBe(item.id);
    expect(articles.persisted[0]!.article.url).toBe('https://a.test');
    expect(items.enriched).toEqual([item.id]);
  });

  it('returns without throwing when the item is missing', async () => {
    const { processor, extractor, articles, items } = makeProcessor();

    await processor.process({
      data: { userId: 'user-1', itemId: 'gone' },
      attemptsMade: 0,
    });

    expect(extractor.calls).toHaveLength(0);
    expect(articles.persisted).toHaveLength(0);
    expect(items.enriched).toHaveLength(0);
  });

  it('returns without throwing when the item userId does not match', async () => {
    const { processor, extractor, items } = makeProcessor();
    const item = makeItem();
    items.items.set(item.id, item);

    await processor.process({
      data: { userId: 'someone-else', itemId: item.id },
      attemptsMade: 0,
    });

    expect(extractor.calls).toHaveLength(0);
    expect(items.enriched).toHaveLength(0);
  });

  it('skips already-enriched items', async () => {
    const { processor, extractor, items } = makeProcessor();
    const item = makeItem({ enriched: true });
    items.items.set(item.id, item);

    await processor.process({
      data: { userId: item.userId, itemId: item.id },
      attemptsMade: 0,
    });

    expect(extractor.calls).toHaveLength(0);
    expect(items.enriched).toHaveLength(0);
  });

  it('marks items with zero URLs as enriched without calling the extractor', async () => {
    const { processor, extractor, items } = makeProcessor();
    const item = makeItem({ urls: [] });
    items.items.set(item.id, item);

    await processor.process({
      data: { userId: item.userId, itemId: item.id },
      attemptsMade: 0,
    });

    expect(extractor.calls).toHaveLength(0);
    expect(items.enriched).toEqual([item.id]);
  });

  it('logs per-URL failures and continues when at least one URL succeeds', async () => {
    const { processor, extractor, items, articles, logger } = makeProcessor();
    const item = makeItem({ urls: ['https://ok.test', 'https://fail.test'] });
    extractor.behavior.set('https://fail.test', 'fail');
    items.items.set(item.id, item);

    await processor.process({
      data: { userId: item.userId, itemId: item.id },
      attemptsMade: 0,
    });

    expect(articles.persisted).toHaveLength(1);
    expect(articles.persisted[0]!.article.url).toBe('https://ok.test');
    expect(items.enriched).toEqual([item.id]);
    expect(logger.logs.some((l) => l.level === 'warn' && l.msg.includes('fail.test'))).toBe(true);
  });

  it('throws when every URL fails so BullMQ retries', async () => {
    const { processor, extractor, items, articles } = makeProcessor();
    const item = makeItem({ urls: ['https://a.test', 'https://b.test'] });
    extractor.defaultBehavior = 'fail';
    items.items.set(item.id, item);

    await expect(
      processor.process({
        data: { userId: item.userId, itemId: item.id },
        attemptsMade: 0,
      }),
    ).rejects.toThrow(/boom/);

    expect(articles.persisted).toHaveLength(0);
    expect(items.enriched).toHaveLength(0);
  });

  it('rethrows the FIRST failure when all URLs fail', async () => {
    const { processor, extractor, items } = makeProcessor();
    const item = makeItem({ urls: ['https://a.test', 'https://b.test'] });
    extractor.defaultBehavior = 'fail';
    items.items.set(item.id, item);

    await expect(
      processor.process({
        data: { userId: item.userId, itemId: item.id },
        attemptsMade: 0,
      }),
    ).rejects.toThrow('boom for https://a.test');
  });
});
