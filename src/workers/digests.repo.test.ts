import { describe, expect, it } from 'bun:test';
import { DigestsRepo } from './digests.repo';

/**
 * In-memory fake of the Appwrite databases slice that `DigestsRepo`
 * uses. Supports the queries the repo actually issues:
 *   - `createDocument`
 *   - `getDocument`
 *   - `listDocuments` with `equal`, `orderDesc`, `limit`, `cursorAfter`.
 */
class FakeDatabases {
  readonly docs = new Map<string, Record<string, unknown> & { $id: string }>();

  async createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    if (this.docs.has(params.documentId)) {
      const err = new Error('Document already exists') as Error & { code: number };
      err.code = 409;
      throw err;
    }
    const id = params.documentId;
    const doc = { $id: id, ...params.data };
    this.docs.set(id, doc);
    return doc;
  }

  async getDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
  }): Promise<Record<string, unknown> & { $id: string }> {
    const doc = this.docs.get(params.documentId);
    if (!doc) {
      const err = new Error('not found') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    return doc;
  }

  async listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }> {
    let orderAttr: string | undefined;
    let orderDesc = false;
    let limit = Number.POSITIVE_INFINITY;
    let cursorAfter: string | undefined;
    const filters: Array<[string, string]> = [];
    for (const q of params.queries ?? []) {
      const parsed = JSON.parse(q) as {
        method?: string;
        attribute?: string;
        values?: unknown[];
      };
      switch (parsed.method) {
        case 'equal':
          filters.push([String(parsed.attribute), String((parsed.values ?? [])[0])]);
          break;
        case 'orderDesc':
          orderAttr = String(parsed.attribute);
          orderDesc = true;
          break;
        case 'orderAsc':
          orderAttr = String(parsed.attribute);
          orderDesc = false;
          break;
        case 'limit':
          limit = Number((parsed.values ?? [])[0]);
          break;
        case 'cursorAfter':
          cursorAfter = String((parsed.values ?? [])[0]);
          break;
      }
    }

    let matched = Array.from(this.docs.values()).filter((d) =>
      filters.every(([field, value]) => String(d[field]) === value),
    );
    if (orderAttr) {
      matched.sort((a, b) => {
        const av = String(a[orderAttr!] ?? '');
        const bv = String(b[orderAttr!] ?? '');
        return orderDesc ? (av < bv ? 1 : av > bv ? -1 : 0) : av < bv ? -1 : av > bv ? 1 : 0;
      });
    }
    if (cursorAfter) {
      const idx = matched.findIndex((d) => d.$id === cursorAfter);
      if (idx >= 0) matched = matched.slice(idx + 1);
    }
    if (Number.isFinite(limit)) matched = matched.slice(0, limit);
    return { total: matched.length, documents: matched };
  }
}

function makeRepo(): { repo: DigestsRepo; db: FakeDatabases } {
  const db = new FakeDatabases();
  const fakeAppwrite = {
    databaseId: 'test-db',
    databases: db as unknown as never,
  };
  return { repo: new DigestsRepo(fakeAppwrite as never), db };
}

const BASE_INPUT = {
  userId: 'u1',
  windowStart: '2026-04-05T00:00:00.000Z',
  windowEnd: '2026-04-06T00:00:00.000Z',
  markdown: '## hi',
  itemIds: ['i1', 'i2'],
  model: 'anthropic/claude-sonnet-4.5',
  tokensIn: 10,
  tokensOut: 5,
};

describe('DigestsRepo.create', () => {
  it('persists every documented field and returns a parsed record', async () => {
    const { repo, db } = makeRepo();
    const result = await repo.create(BASE_INPUT);
    expect(typeof result.id).toBe('string');
    expect(result.userId).toBe('u1');
    expect(result.windowStart).toBe('2026-04-05T00:00:00.000Z');
    expect(result.windowEnd).toBe('2026-04-06T00:00:00.000Z');
    expect(result.markdown).toBe('## hi');
    expect(result.itemIds).toEqual(['i1', 'i2']);
    expect(result.model).toBe('anthropic/claude-sonnet-4.5');
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(5);
    const stored = db.docs.get(result.id);
    expect(typeof stored?.createdAt).toBe('string');
  });

  it('is idempotent — a second create with the same window returns the existing row', async () => {
    const { repo, db } = makeRepo();
    const first = await repo.create(BASE_INPUT);
    const second = await repo.create({ ...BASE_INPUT, markdown: '## different' });
    expect(second.id).toBe(first.id);
    expect(second.markdown).toBe('## hi');
    expect(db.docs.size).toBe(1);
  });

  it('uses a deterministic document id based on userId + window bounds', async () => {
    const { repo: repo1 } = makeRepo();
    const { repo: repo2 } = makeRepo();
    const a = await repo1.create(BASE_INPUT);
    const b = await repo2.create(BASE_INPUT);
    expect(a.id).toBe(b.id);
  });
});

describe('DigestsRepo.findByIdAndUser', () => {
  it('returns the row when owned by the caller', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(BASE_INPUT);
    const found = await repo.findByIdAndUser(created.id, 'u1');
    expect(found?.id).toBe(created.id);
    expect(found?.markdown).toBe('## hi');
  });

  it('returns null when the row belongs to a different user', async () => {
    const { repo } = makeRepo();
    const created = await repo.create(BASE_INPUT);
    const found = await repo.findByIdAndUser(created.id, 'someone-else');
    expect(found).toBeNull();
  });

  it('returns null when the id does not exist', async () => {
    const { repo } = makeRepo();
    const found = await repo.findByIdAndUser('nope', 'u1');
    expect(found).toBeNull();
  });
});

describe('DigestsRepo.listByUser', () => {
  it('returns rows newest first for the given user', async () => {
    const { repo } = makeRepo();
    const a = await repo.create({
      ...BASE_INPUT,
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-04-02T00:00:00.000Z',
    });
    await new Promise((r) => setTimeout(r, 2));
    const b = await repo.create({
      ...BASE_INPUT,
      windowStart: '2026-04-02T00:00:00.000Z',
      windowEnd: '2026-04-03T00:00:00.000Z',
    });
    await new Promise((r) => setTimeout(r, 2));
    const c = await repo.create({
      ...BASE_INPUT,
      windowStart: '2026-04-03T00:00:00.000Z',
      windowEnd: '2026-04-04T00:00:00.000Z',
    });

    const result = await repo.listByUser({ userId: 'u1', limit: 10 });
    expect(result.items.map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('scopes listings by userId', async () => {
    const { repo } = makeRepo();
    await repo.create({ ...BASE_INPUT, userId: 'u1' });
    await repo.create({ ...BASE_INPUT, userId: 'u2' });
    const result = await repo.listByUser({ userId: 'u1', limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.userId).toBe('u1');
  });

  it('paginates via nextCursor', async () => {
    const { repo } = makeRepo();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2));
      const row = await repo.create({
        ...BASE_INPUT,
        windowStart: `2026-04-0${i + 1}T00:00:00.000Z`,
        windowEnd: `2026-04-0${i + 2}T00:00:00.000Z`,
      });
      ids.push(row.id);
    }
    const expectedNewestFirst = [...ids].reverse();
    const page1 = await repo.listByUser({ userId: 'u1', limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(expectedNewestFirst.slice(0, 2));
    expect(page1.nextCursor).toBe(expectedNewestFirst[1]);

    const page2 = await repo.listByUser({
      userId: 'u1',
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.id)).toEqual(expectedNewestFirst.slice(2, 4));
    expect(page2.nextCursor).toBe(expectedNewestFirst[3]);

    const page3 = await repo.listByUser({
      userId: 'u1',
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((i) => i.id)).toEqual(expectedNewestFirst.slice(4, 5));
    expect(page3.nextCursor).toBeUndefined();
  });
});
