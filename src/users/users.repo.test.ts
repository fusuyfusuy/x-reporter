import { describe, expect, it } from 'bun:test';
import { UsersRepo, type UserRecord } from './users.repo';

/**
 * In-memory fake of the slice of `AppwriteService.databases` that
 * `UsersRepo` actually consumes. Stores documents in a Map keyed by
 * `$id`. Implements just enough of the SDK shape to satisfy the calls
 * `UsersRepo` makes:
 *
 *   - listDocuments({ databaseId, collectionId, queries })  → filtered list
 *   - createDocument({ databaseId, collectionId, documentId, data })
 *   - getDocument({ databaseId, collectionId, documentId })
 *   - updateDocument({ databaseId, collectionId, documentId, data })
 *
 * Query support is intentionally minimal — only the equality predicates
 * `UsersRepo` actually emits. Anything more elaborate would be testing
 * the fake instead of the repo.
 */
class FakeDatabases {
  readonly docs = new Map<string, Record<string, unknown> & { $id: string }>();

  async listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }> {
    // Fail closed on unknown query shapes. The previous version dropped
    // unparseable queries silently, which let an earlier regex regression
    // turn the fake into a match-all helper without any test noticing.
    // Throwing here makes any future Appwrite query-shape drift loud
    // instead of silently degrading filtering.
    const filters: Array<[string, string]> = (params.queries ?? []).map((q) => {
      const parsed = parseEqualQuery(q);
      if (!parsed) {
        throw new Error(`unsupported fake Appwrite query: ${q}`);
      }
      return parsed;
    });
    const all = Array.from(this.docs.values());
    const matched = all.filter((d) =>
      filters.every(([field, value]) => String(d[field]) === value),
    );
    return { total: matched.length, documents: matched };
  }

  async createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    // Mirror the real Appwrite collection's `xUserId_unique` index — two
    // concurrent first-time sign-ins for the same X user must produce a
    // 409 on the loser, which is what `UsersRepo.upsertByXUserId()`'s
    // post-conflict re-read branch relies on. Without this, the fake
    // would silently let both writes through and the race-recovery path
    // would never be exercised.
    const xUserId = params.data.xUserId;
    if (
      typeof xUserId === 'string' &&
      Array.from(this.docs.values()).some((doc) => doc.xUserId === xUserId)
    ) {
      const err = new Error('xUserId already exists') as Error & { code: number };
      err.code = 409;
      throw err;
    }
    if (this.docs.has(params.documentId)) {
      const err = new Error('document already exists') as Error & { code: number };
      err.code = 409;
      throw err;
    }
    const doc = { $id: params.documentId, ...params.data };
    this.docs.set(params.documentId, doc);
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

  async updateDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    const existing = this.docs.get(params.documentId);
    if (!existing) {
      const err = new Error('not found') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    const updated = { ...existing, ...params.data };
    this.docs.set(params.documentId, updated);
    return updated;
  }
}

/**
 * Parse an Appwrite v23 Query string back into a `[field, value]` tuple.
 *
 * `node-appwrite` >= 14 emits queries as JSON of the shape
 * `{"method":"equal","attribute":"xUserId","values":["12345"]}` (see
 * sdk-for-node/src/query.ts). The earlier regex-based parser expected
 * the long-gone `equal("xUserId", ["12345"])` syntax and silently
 * returned `null` for every real query, which made the fake's
 * `listDocuments` return *every* row instead of filtering — tests only
 * passed because each test stored a single document. Switching to
 * `JSON.parse` makes the filter actually work and locks the contract
 * the production repo relies on.
 */
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

function makeRepo(): { repo: UsersRepo; db: FakeDatabases } {
  const db = new FakeDatabases();
  const fakeAppwrite = {
    databaseId: 'test-db',
    databases: db as unknown as never,
  };
  return { repo: new UsersRepo(fakeAppwrite as never), db };
}

describe('UsersRepo.upsertByXUserId', () => {
  it('creates a new user with status="active" on first call', async () => {
    const { repo } = makeRepo();
    const user = await repo.upsertByXUserId({ xUserId: '12345', handle: 'fusuyfusuy' });
    expect(user.xUserId).toBe('12345');
    expect(user.handle).toBe('fusuyfusuy');
    expect(user.status).toBe('active');
    expect(user.id).toBeDefined();
    expect(typeof user.id).toBe('string');
    expect(user.createdAt).toBeDefined();
  });

  it('returns the same user id on a second call with the same xUserId (idempotent)', async () => {
    const { repo } = makeRepo();
    const a = await repo.upsertByXUserId({ xUserId: '12345', handle: 'fusuyfusuy' });
    const b = await repo.upsertByXUserId({ xUserId: '12345', handle: 'fusuyfusuy' });
    expect(b.id).toBe(a.id);
  });

  it('updates the handle if X reports a different one on re-sign-in', async () => {
    const { repo } = makeRepo();
    await repo.upsertByXUserId({ xUserId: '12345', handle: 'old_handle' });
    const after = await repo.upsertByXUserId({ xUserId: '12345', handle: 'new_handle' });
    expect(after.handle).toBe('new_handle');
  });

  it('resets status from auth_expired back to active on re-sign-in', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    await repo.setStatus(u.id, 'auth_expired');
    const after = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    expect(after.status).toBe('active');
  });

  it('recovers from a concurrent first-time sign-in race (createDocument 409)', async () => {
    // Simulate two concurrent first-time sign-ins for the same X user:
    // both calls see no existing row in their initial findByXUserId, both
    // race to createDocument, the database's xUserId unique index lets
    // one win and rejects the loser with 409. The loser's upsert path
    // must catch the 409, re-read, and return the winner row instead of
    // bubbling the error.
    const { repo, db } = makeRepo();

    // Override findByXUserId-equivalent listDocuments so the *first* call
    // sees nothing (matching the pre-race state) and subsequent calls
    // return whatever's actually in the fake. This forces the
    // upsertByXUserId code into the create-then-conflict branch.
    const realList = db.listDocuments.bind(db);
    let listCalls = 0;
    db.listDocuments = (async (params: Parameters<typeof realList>[0]) => {
      listCalls += 1;
      if (listCalls === 1) {
        return { total: 0, documents: [] };
      }
      return realList(params);
    }) as typeof db.listDocuments;

    // Pre-seed the winner row directly so createDocument's xUserId
    // uniqueness check fires.
    db.docs.set('winner-id', {
      $id: 'winner-id',
      xUserId: '12345',
      handle: 'fusuyfusuy',
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const result = await repo.upsertByXUserId({
      xUserId: '12345',
      handle: 'fusuyfusuy',
    });
    expect(result.id).toBe('winner-id');
    expect(result.xUserId).toBe('12345');
    expect(result.handle).toBe('fusuyfusuy');
    expect(result.status).toBe('active');
  });

  it('does NOT unpause a paused user, even when their handle changes', async () => {
    // A paused user is an explicit user/admin choice — re-auth (or a
    // handle rename) should never silently undo it. Only auth_expired
    // rows are revived to active by upsertByXUserId.
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'old_handle' });
    await repo.setStatus(u.id, 'paused');
    const after = await repo.upsertByXUserId({ xUserId: '12345', handle: 'new_handle' });
    expect(after.status).toBe('paused');
    expect(after.handle).toBe('new_handle');
  });
});

describe('UsersRepo.setStatus', () => {
  it('updates only the status field', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'fusuyfusuy' });
    const updated = await repo.setStatus(u.id, 'auth_expired');
    expect(updated.status).toBe('auth_expired');
    // Other fields untouched.
    expect(updated.xUserId).toBe('12345');
    expect(updated.handle).toBe('fusuyfusuy');
    expect(updated.id).toBe(u.id);
  });

  it('throws when the user does not exist', async () => {
    const { repo } = makeRepo();
    await expect(repo.setStatus('does-not-exist', 'auth_expired')).rejects.toThrow();
  });
});

describe('UsersRepo.findByXUserId', () => {
  it('returns null when no user matches', async () => {
    const { repo } = makeRepo();
    expect(await repo.findByXUserId('nope')).toBeNull();
  });

  it('returns the user when one matches', async () => {
    const { repo } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const found = await repo.findByXUserId('12345');
    expect(found).not.toBeNull();
    expect((found as UserRecord).id).toBe(created.id);
  });

  it('only returns the matching user when multiple users exist (filter actually filters)', async () => {
    // Regression: an earlier version of the test fake's parseEqualQuery
    // expected the long-gone `equal("field", ["value"])` syntax instead
    // of the JSON shape node-appwrite v23 actually emits, which made
    // listDocuments silently return *every* document. With only one row
    // per test the bug was invisible. This test seeds three users so
    // any future regression in the query parser is loud.
    const { repo } = makeRepo();
    await repo.upsertByXUserId({ xUserId: '111', handle: 'alice' });
    const target = await repo.upsertByXUserId({ xUserId: '222', handle: 'bob' });
    await repo.upsertByXUserId({ xUserId: '333', handle: 'carol' });
    const found = await repo.findByXUserId('222');
    expect(found).not.toBeNull();
    expect((found as UserRecord).id).toBe(target.id);
    expect((found as UserRecord).handle).toBe('bob');
  });
});

describe('UsersRepo.findById', () => {
  it('returns null when the id is unknown', async () => {
    const { repo } = makeRepo();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('returns the user when the id matches', async () => {
    const { repo } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect((found as UserRecord).xUserId).toBe('12345');
  });

  it('surfaces stored cadence values when present on the row', async () => {
    // Cadence fields are optional at the DB level (data-model.md), so a
    // freshly upserted row has them undefined. Once a value has been
    // written via updateCadence (or seeded directly), findById must
    // round-trip it as a number rather than dropping it on the floor.
    const { repo, db } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const stored = db.docs.get(created.id);
    if (!stored) throw new Error('seeded row missing');
    stored.pollIntervalMin = 30;
    stored.digestIntervalMin = 720;
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect((found as UserRecord).pollIntervalMin).toBe(30);
    expect((found as UserRecord).digestIntervalMin).toBe(720);
  });

  it('leaves cadence undefined when the row has never been patched', async () => {
    const { repo } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect((found as UserRecord).pollIntervalMin).toBeUndefined();
    expect((found as UserRecord).digestIntervalMin).toBeUndefined();
  });

  it('throws on a stored pollIntervalMin below the documented minimum', async () => {
    // Defense against hand-edited rows. The HTTP zod schema enforces
    // `>= 5` on writes, but a value of 0 (or negative) flowing through
    // the read path would be served from `GET /me` and break the
    // contract clients are promised. Failing loudly here is preferable
    // to silently shipping a bad value.
    const { repo, db } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const stored = db.docs.get(created.id);
    if (!stored) throw new Error('seeded row missing');
    stored.pollIntervalMin = 0;
    await expect(repo.findById(created.id)).rejects.toThrow(/out-of-range/);
  });

  it('throws on a stored digestIntervalMin below the documented minimum', async () => {
    const { repo, db } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const stored = db.docs.get(created.id);
    if (!stored) throw new Error('seeded row missing');
    stored.digestIntervalMin = 14;
    await expect(repo.findById(created.id)).rejects.toThrow(/out-of-range/);
  });

  it('surfaces stored cursor values when present on the row', async () => {
    const { repo, db } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const stored = db.docs.get(created.id);
    if (!stored) throw new Error('seeded row missing');
    stored.lastLikeCursor = 'abc123';
    stored.lastBookmarkCursor = 'def456';
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect((found as UserRecord).lastLikeCursor).toBe('abc123');
    expect((found as UserRecord).lastBookmarkCursor).toBe('def456');
  });

  it('leaves cursors undefined when the row has never been polled', async () => {
    const { repo } = makeRepo();
    const created = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect((found as UserRecord).lastLikeCursor).toBeUndefined();
    expect((found as UserRecord).lastBookmarkCursor).toBeUndefined();
  });
});

describe('UsersRepo.updateCadence', () => {
  it('writes pollIntervalMin and returns the updated record', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCadence(u.id, { pollIntervalMin: 30 });
    expect(updated).not.toBeNull();
    expect((updated as UserRecord).id).toBe(u.id);
    expect((updated as UserRecord).pollIntervalMin).toBe(30);
    // Untouched fields preserved.
    expect((updated as UserRecord).xUserId).toBe('12345');
    expect((updated as UserRecord).handle).toBe('h');
    expect((updated as UserRecord).status).toBe('active');
  });

  it('writes digestIntervalMin and returns the updated record', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCadence(u.id, { digestIntervalMin: 720 });
    expect((updated as UserRecord).digestIntervalMin).toBe(720);
  });

  it('writes both fields when both are supplied', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCadence(u.id, {
      pollIntervalMin: 15,
      digestIntervalMin: 60,
    });
    expect((updated as UserRecord).pollIntervalMin).toBe(15);
    expect((updated as UserRecord).digestIntervalMin).toBe(60);
  });

  it('leaves an unspecified field untouched on a partial patch', async () => {
    // The repo must NOT clobber the other field with `undefined` — that
    // would erase a previous patch and silently flip the user back to the
    // documented default. Only the keys present in the patch may be sent
    // to Appwrite.
    const { repo, db } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    await repo.updateCadence(u.id, { pollIntervalMin: 10, digestIntervalMin: 30 });
    const after = await repo.updateCadence(u.id, { pollIntervalMin: 99 });
    expect((after as UserRecord).pollIntervalMin).toBe(99);
    expect((after as UserRecord).digestIntervalMin).toBe(30);
    // Sanity-check the underlying doc — confirms updateCadence didn't
    // write a literal `undefined` for digestIntervalMin.
    const stored = db.docs.get(u.id);
    expect(stored?.digestIntervalMin).toBe(30);
  });

  it('returns null when the user does not exist (concurrent-delete race)', async () => {
    // Mirrors `findById` / `findByXUserId` semantics: "row gone" is a
    // documented application state, not an exceptional condition. The
    // service maps the null to `UserNotFoundError` so the controller
    // can answer `404 not_found` instead of leaking a 500. Without
    // this branch a user deleted between session-cookie issue and
    // PATCH would surface as a generic upstream error.
    const { repo } = makeRepo();
    const result = await repo.updateCadence('does-not-exist', {
      pollIntervalMin: 10,
    });
    expect(result).toBeNull();
  });

  it('rejects an empty patch (no fields supplied)', async () => {
    // Belt-and-braces. The HTTP zod schema rejects empty bodies first,
    // but the repo should not silently issue a no-op write either.
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    await expect(repo.updateCadence(u.id, {})).rejects.toThrow();
  });
});
