import { describe, expect, it } from 'bun:test';
import { decrypt, encrypt, loadEncryptionKey } from '../common/crypto';
import { TokensRepo, type TokenRecord } from './tokens.repo';

const VALID_KEY_B64 = Buffer.alloc(32, 11).toString('base64');

/**
 * Same minimal in-memory fake of `appwrite.databases` used in
 * `users.repo.test`. Kept local rather than shared because the two repos
 * intentionally exercise the same surface — duplicating the fake makes
 * each test file fully self-contained and easy to delete when the repos
 * move out of `src/auth/`'s adjacency.
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

function parseEqualQuery(q: string): [string, string] | null {
  const m = q.match(/^equal\("([^"]+)",\s*\[?"?([^"\]]+)"?\]?\)$/);
  if (!m) return null;
  return [m[1]!, m[2]!];
}

function makeRepo(): { repo: TokensRepo; db: FakeDatabases } {
  const db = new FakeDatabases();
  const fakeAppwrite = {
    databaseId: 'test-db',
    databases: db as unknown as never,
  };
  return { repo: new TokensRepo(fakeAppwrite as never), db };
}

const futureIso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();

describe('TokensRepo.upsertForUser', () => {
  it('creates a new tokens row on first call', async () => {
    const { repo, db } = makeRepo();
    const expiresAt = futureIso(7200_000);
    const saved = await repo.upsertForUser({
      userId: 'u_1',
      accessToken: 'cipher-access',
      refreshToken: 'cipher-refresh',
      expiresAt,
      scope: 'tweet.read',
    });
    expect(saved.userId).toBe('u_1');
    expect(saved.accessToken).toBe('cipher-access');
    expect(saved.refreshToken).toBe('cipher-refresh');
    expect(saved.expiresAt).toBe(expiresAt);
    expect(saved.scope).toBe('tweet.read');
    // The document was actually persisted to the fake.
    expect(db.docs.size).toBe(1);
  });

  it('updates the existing row on a second call for the same user (idempotent)', async () => {
    const { repo, db } = makeRepo();
    await repo.upsertForUser({
      userId: 'u_1',
      accessToken: 'cipher-access-1',
      refreshToken: 'cipher-refresh-1',
      expiresAt: futureIso(3600_000),
      scope: 'tweet.read',
    });
    const second = await repo.upsertForUser({
      userId: 'u_1',
      accessToken: 'cipher-access-2',
      refreshToken: 'cipher-refresh-2',
      expiresAt: futureIso(7200_000),
      scope: 'tweet.read users.read',
    });
    expect(second.accessToken).toBe('cipher-access-2');
    expect(second.refreshToken).toBe('cipher-refresh-2');
    expect(second.scope).toBe('tweet.read users.read');
    // Still exactly one row.
    expect(db.docs.size).toBe(1);
  });
});

describe('TokensRepo.findByUserId', () => {
  it('returns null when no tokens exist for the user', async () => {
    const { repo } = makeRepo();
    expect(await repo.findByUserId('nope')).toBeNull();
  });

  it('returns the row when one exists', async () => {
    const { repo } = makeRepo();
    const expiresAt = futureIso(3600_000);
    await repo.upsertForUser({
      userId: 'u_1',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt,
      scope: 's',
    });
    const found = (await repo.findByUserId('u_1')) as TokenRecord;
    expect(found).not.toBeNull();
    expect(found.userId).toBe('u_1');
    expect(found.accessToken).toBe('a');
    expect(found.refreshToken).toBe('r');
    expect(found.expiresAt).toBe(expiresAt);
    expect(found.scope).toBe('s');
  });
});

describe('TokensRepo + crypto round-trip', () => {
  it('persists encrypted tokens that can be decrypted on read', async () => {
    const { repo } = makeRepo();
    const key = loadEncryptionKey(VALID_KEY_B64);
    const accessPlain = 'real-access-token-from-x';
    const refreshPlain = 'real-refresh-token-from-x';
    await repo.upsertForUser({
      userId: 'u_1',
      accessToken: encrypt(accessPlain, key),
      refreshToken: encrypt(refreshPlain, key),
      expiresAt: futureIso(7200_000),
      scope: 'tweet.read users.read',
    });
    const found = (await repo.findByUserId('u_1')) as TokenRecord;
    expect(decrypt(found.accessToken, key)).toBe(accessPlain);
    expect(decrypt(found.refreshToken, key)).toBe(refreshPlain);
  });
});
