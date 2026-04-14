import { describe, expect, it } from 'bun:test';
import { ArticlesRepo } from './articles.repo';

class FakeDatabases {
  readonly docs = new Map<string, Record<string, unknown> & { $id: string }>();
  private nextId = 1;
  conflictMode: 'off' | 'once' = 'off';
  private conflictFired = false;

  async createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    if (this.conflictMode === 'once' && !this.conflictFired) {
      this.conflictFired = true;
      const err = new Error('document already exists') as Error & { code: number };
      err.code = 409;
      throw err;
    }
    const id = `doc-${this.nextId++}`;
    const doc = { $id: id, ...params.data };
    this.docs.set(id, doc);
    return doc;
  }

  async listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }> {
    const filters: Array<[string, string]> = (params.queries ?? []).map((q) => {
      const parsed = JSON.parse(q) as { attribute: string; values: unknown[] };
      return [parsed.attribute, String(parsed.values[0])];
    });
    const all = Array.from(this.docs.values());
    const matched = all.filter((d) =>
      filters.every(([field, value]) => String(d[field]) === value),
    );
    return { total: matched.length, documents: matched };
  }
}

function makeRepo(): { repo: ArticlesRepo; db: FakeDatabases } {
  const db = new FakeDatabases();
  const fakeAppwrite = {
    databaseId: 'test-db',
    databases: db as unknown as never,
  };
  return { repo: new ArticlesRepo(fakeAppwrite as never), db };
}

describe('ArticlesRepo.create', () => {
  it('creates a new article row and returns its id', async () => {
    const { repo, db } = makeRepo();
    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: '# hi',
      extractor: 'firecrawl',
      title: 'Hi',
    });
    expect(typeof result.id).toBe('string');
    expect(result.itemId).toBe('item-1');
    expect(result.url).toBe('https://a.test');
    expect(result.title).toBe('Hi');
    expect(db.docs.size).toBe(1);
  });

  it('is idempotent: a second create for the same (itemId, url) returns the first row', async () => {
    const { repo, db } = makeRepo();
    const first = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'first',
      extractor: 'firecrawl',
    });
    const second = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'second-should-not-replace',
      extractor: 'firecrawl',
    });
    expect(second.id).toBe(first.id);
    expect(second.content).toBe('first');
    expect(db.docs.size).toBe(1);
  });

  it('returns the existing row via the pre-check even when it was written concurrently', async () => {
    const { repo, db } = makeRepo();
    // Simulate a concurrent writer having created the row first.
    db.docs.set('race-winner', {
      $id: 'race-winner',
      itemId: 'item-1',
      url: 'https://a.test',
      content: 'winner',
      extractor: 'firecrawl',
      extractedAt: new Date().toISOString(),
    });
    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'loser',
      extractor: 'firecrawl',
    });
    expect(result.id).toBe('race-winner');
    expect(result.content).toBe('winner');
    expect(db.docs.size).toBe(1);
  });

  it('recovers from a 409 conflict by re-querying for the concurrent winner', async () => {
    // This exercises the `catch (isConflict)` branch in ArticlesRepo.create:
    // the pre-check misses (empty DB at first list), createDocument throws
    // 409 as a concurrent writer wins the race, and the repo re-queries
    // listDocuments to return that winner.
    const { repo, db } = makeRepo();
    db.conflictMode = 'once';

    // The second listDocuments call should find the winner. We simulate
    // the concurrent writer by inserting the winner row just before the
    // conflicting createDocument call fires — easiest way: hook the fake
    // so the first createDocument call also seeds the winner as a side
    // effect of throwing.
    const originalCreate = db.createDocument.bind(db);
    db.createDocument = async (params) => {
      // On the first call (which will throw 409) seed the winner row so
      // the post-conflict re-query can find it.
      if (!db.docs.has('race-winner')) {
        db.docs.set('race-winner', {
          $id: 'race-winner',
          itemId: 'item-1',
          url: 'https://a.test',
          content: 'winner',
          extractor: 'firecrawl',
          extractedAt: new Date().toISOString(),
        });
      }
      return originalCreate(params);
    };

    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'loser',
      extractor: 'firecrawl',
    });

    expect(result.id).toBe('race-winner');
    expect(result.content).toBe('winner');
    // Exactly one row — the winner — not the loser's attempted write.
    expect(db.docs.size).toBe(1);
  });

  it('rethrows the 409 when the post-conflict re-query still finds no winner', async () => {
    // Defensive branch: if the DB really has no matching row after a 409,
    // the caller needs to see the original error rather than silently
    // returning null.
    const { repo, db } = makeRepo();
    db.conflictMode = 'once';

    await expect(
      repo.create('item-1', {
        url: 'https://a.test',
        content: 'body',
        extractor: 'firecrawl',
      }),
    ).rejects.toThrow(/document already exists/);
  });

  it('stores optional metadata fields when provided', async () => {
    const { repo, db } = makeRepo();
    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'body',
      extractor: 'firecrawl',
      canonicalUrl: 'https://canonical.test',
      title: 'Title',
      byline: 'Alice',
      siteName: 'Example',
    });
    const doc = db.docs.get(result.id)!;
    expect(doc.canonicalUrl).toBe('https://canonical.test');
    expect(doc.title).toBe('Title');
    expect(doc.byline).toBe('Alice');
    expect(doc.siteName).toBe('Example');
  });

  it('omits optional fields that are undefined instead of writing nulls', async () => {
    const { repo, db } = makeRepo();
    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'body',
      extractor: 'firecrawl',
    });
    const doc = db.docs.get(result.id)!;
    expect('canonicalUrl' in doc).toBe(false);
    expect('title' in doc).toBe(false);
    expect('byline' in doc).toBe(false);
    expect('siteName' in doc).toBe(false);
  });

  it('sets extractedAt to an ISO timestamp', async () => {
    const { repo, db } = makeRepo();
    const before = new Date().toISOString();
    const result = await repo.create('item-1', {
      url: 'https://a.test',
      content: 'body',
      extractor: 'firecrawl',
    });
    const doc = db.docs.get(result.id)!;
    expect(typeof doc.extractedAt).toBe('string');
    expect((doc.extractedAt as string) >= before).toBe(true);
  });
});
