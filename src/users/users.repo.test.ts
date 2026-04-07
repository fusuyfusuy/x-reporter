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
    const filters = (params.queries ?? []).map(parseEqualQuery).filter(Boolean) as Array<
      [string, string]
    >;
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
 * Parse an Appwrite Query string of the form `equal("field", ["value"])`
 * back into a `[field, value]` tuple. Returns `null` for anything else.
 * The repo only emits equality queries, so this is sufficient.
 */
function parseEqualQuery(q: string): [string, string] | null {
  const m = q.match(/^equal\("([^"]+)",\s*\[?"?([^"\]]+)"?\]?\)$/);
  if (!m) return null;
  return [m[1]!, m[2]!];
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
});
