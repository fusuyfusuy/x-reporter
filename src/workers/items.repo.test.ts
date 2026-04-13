import { describe, expect, it } from 'bun:test';
import { ItemsRepo } from './items.repo';

/**
 * In-memory fake of the Appwrite databases slice that `ItemsRepo` uses.
 * Mirrors the compound unique index `(userId, xTweetId)` from the real
 * schema by checking for duplicates on create.
 */
class FakeDatabases {
  readonly docs = new Map<string, Record<string, unknown> & { $id: string }>();
  private nextId = 1;

  async createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    const userId = params.data.userId;
    const xTweetId = params.data.xTweetId;
    if (typeof userId === 'string' && typeof xTweetId === 'string') {
      for (const doc of this.docs.values()) {
        if (doc.userId === userId && doc.xTweetId === xTweetId) {
          const err = new Error('document already exists') as Error & { code: number };
          err.code = 409;
          throw err;
        }
      }
    }
    // Simulate ID.unique() by using a counter.
    const docId = `doc-${this.nextId++}`;
    const doc = { $id: docId, ...params.data };
    this.docs.set(docId, doc);
    return doc;
  }

  async listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }> {
    const filters: Array<[string, string]> = (params.queries ?? []).map((q) => {
      const parsed = parseEqualQuery(q);
      if (!parsed) throw new Error(`unsupported fake query: ${q}`);
      return parsed;
    });
    const all = Array.from(this.docs.values());
    const matched = all.filter((d) =>
      filters.every(([field, value]) => String(d[field]) === value),
    );
    return { total: matched.length, documents: matched };
  }
}

function parseEqualQuery(q: string): [string, string] | null {
  try {
    const parsed = JSON.parse(q) as {
      method?: unknown;
      attribute?: unknown;
      values?: unknown;
    };
    if (parsed.method !== 'equal') return null;
    if (typeof parsed.attribute !== 'string') return null;
    if (!Array.isArray(parsed.values) || parsed.values.length === 0) return null;
    return [parsed.attribute, String(parsed.values[0])];
  } catch {
    return null;
  }
}

function makeRepo(): { repo: ItemsRepo; db: FakeDatabases } {
  const db = new FakeDatabases();
  const fakeAppwrite = {
    databaseId: 'test-db',
    databases: db as unknown as never,
  };
  return { repo: new ItemsRepo(fakeAppwrite as never), db };
}

describe('ItemsRepo.upsertMany', () => {
  it('creates new items and marks them as isNew', async () => {
    const { repo } = makeRepo();
    const results = await repo.upsertMany('user1', [
      {
        tweetId: 'tweet1',
        text: 'hello world',
        authorHandle: 'alice',
        urls: ['https://example.com'],
        kind: 'like',
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.isNew).toBe(true);
    expect(typeof results[0]!.id).toBe('string');
  });

  it('marks duplicate items as not new on second upsert', async () => {
    const { repo } = makeRepo();
    const items = [
      {
        tweetId: 'tweet1',
        text: 'hello',
        authorHandle: 'alice',
        urls: [],
        kind: 'like' as const,
      },
    ];
    const first = await repo.upsertMany('user1', items);
    expect(first[0]!.isNew).toBe(true);
    const second = await repo.upsertMany('user1', items);
    expect(second[0]!.isNew).toBe(false);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it('handles a mix of new and existing items', async () => {
    const { repo } = makeRepo();
    await repo.upsertMany('user1', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
    ]);
    const results = await repo.upsertMany('user1', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
      { tweetId: 't2', text: 'b', authorHandle: 'b', urls: [], kind: 'bookmark' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.isNew).toBe(false);
    expect(results[1]!.isNew).toBe(true);
  });

  it('sets enriched to false on new items', async () => {
    const { repo, db } = makeRepo();
    const results = await repo.upsertMany('user1', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
    ]);
    const doc = db.docs.get(results[0]!.id);
    expect(doc?.enriched).toBe(false);
  });

  it('sets fetchedAt to an ISO timestamp on new items', async () => {
    const { repo, db } = makeRepo();
    const before = new Date().toISOString();
    const results = await repo.upsertMany('user1', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
    ]);
    const doc = db.docs.get(results[0]!.id);
    expect(typeof doc?.fetchedAt).toBe('string');
    expect(doc!.fetchedAt! >= before).toBe(true);
  });

  it('returns empty array for empty input', async () => {
    const { repo } = makeRepo();
    const results = await repo.upsertMany('user1', []);
    expect(results).toHaveLength(0);
  });

  it('allows the same tweetId for different users', async () => {
    const { repo } = makeRepo();
    const r1 = await repo.upsertMany('user1', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
    ]);
    const r2 = await repo.upsertMany('user2', [
      { tweetId: 't1', text: 'a', authorHandle: 'a', urls: [], kind: 'like' },
    ]);
    expect(r1[0]!.isNew).toBe(true);
    expect(r2[0]!.isNew).toBe(true);
    expect(r1[0]!.id).not.toBe(r2[0]!.id);
  });
});
