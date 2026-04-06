import { describe, expect, it } from 'bun:test';
import { COLLECTIONS, runSetup, type SetupClient } from './setup-appwrite';

/**
 * Minimal in-memory fake of the parts of `node-appwrite`'s `Databases` API
 * that the setup script touches. Used to assert idempotency without needing
 * a real Appwrite instance.
 */
class FakeAppwrite implements SetupClient {
  databases = new Map<string, { name: string }>();
  collections = new Map<
    string,
    {
      databaseId: string;
      collectionId: string;
      name: string;
      attributes: Map<string, { key: string; status: string }>;
      indexes: Map<string, { key: string; type: string; attributes: string[]; orders?: string[] }>;
    }
  >();
  /** Per-(db,col,key) error queue used to inject faults. */
  private faults = new Map<string, Error>();
  /** Number of "create" calls observed (any kind). Used to check no-op runs. */
  createCalls = 0;
  /** Per-method create-call counters for finer assertions. */
  callCounts = {
    createDatabase: 0,
    createCollection: 0,
    createStringAttribute: 0,
    createIntegerAttribute: 0,
    createBooleanAttribute: 0,
    createDatetimeAttribute: 0,
    createEnumAttribute: 0,
    createIndex: 0,
  };

  private colKey(db: string, col: string) {
    return `${db}/${col}`;
  }

  async getDatabase(params: { databaseId: string }) {
    const found = this.databases.get(params.databaseId);
    if (!found) throw makeAppwriteError(404, 'Database not found');
    return { $id: params.databaseId, name: found.name };
  }

  async createDatabase(params: { databaseId: string; name: string }) {
    this.createCalls++;
    this.callCounts.createDatabase++;
    if (this.databases.has(params.databaseId)) {
      throw makeAppwriteError(409, 'Database already exists');
    }
    this.databases.set(params.databaseId, { name: params.name });
    return { $id: params.databaseId, name: params.name };
  }

  async getCollection(params: { databaseId: string; collectionId: string }) {
    const key = this.colKey(params.databaseId, params.collectionId);
    const found = this.collections.get(key);
    if (!found) throw makeAppwriteError(404, 'Collection not found');
    return { $id: params.collectionId, name: found.name };
  }

  async createCollection(params: {
    databaseId: string;
    collectionId: string;
    name: string;
    permissions?: string[];
  }) {
    this.createCalls++;
    this.callCounts.createCollection++;
    const key = this.colKey(params.databaseId, params.collectionId);
    if (this.collections.has(key)) {
      throw makeAppwriteError(409, 'Collection already exists');
    }
    this.collections.set(key, {
      databaseId: params.databaseId,
      collectionId: params.collectionId,
      name: params.name,
      attributes: new Map(),
      indexes: new Map(),
    });
    return { $id: params.collectionId, name: params.name };
  }

  async listAttributes(params: { databaseId: string; collectionId: string }) {
    const col = this.collections.get(this.colKey(params.databaseId, params.collectionId));
    if (!col) throw makeAppwriteError(404, 'Collection not found');
    return { total: col.attributes.size, attributes: Array.from(col.attributes.values()) };
  }

  private addAttribute(
    method: keyof FakeAppwrite['callCounts'],
    db: string,
    col: string,
    key: string,
  ) {
    this.createCalls++;
    this.callCounts[method]++;
    const c = this.collections.get(this.colKey(db, col));
    if (!c) throw makeAppwriteError(404, 'Collection not found');
    if (c.attributes.has(key)) {
      throw makeAppwriteError(409, 'Attribute already exists');
    }
    // Attributes become "available" immediately in the fake.
    c.attributes.set(key, { key, status: 'available' });
    return { key, status: 'available' };
  }

  async createStringAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    size: number;
    required: boolean;
    array?: boolean;
  }) {
    return this.addAttribute('createStringAttribute', params.databaseId, params.collectionId, params.key);
  }

  async createIntegerAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
    min?: number;
    max?: number;
    xdefault?: number;
  }) {
    return this.addAttribute(
      'createIntegerAttribute',
      params.databaseId,
      params.collectionId,
      params.key,
    );
  }

  async createBooleanAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
    xdefault?: boolean;
  }) {
    return this.addAttribute(
      'createBooleanAttribute',
      params.databaseId,
      params.collectionId,
      params.key,
    );
  }

  async createDatetimeAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
  }) {
    return this.addAttribute(
      'createDatetimeAttribute',
      params.databaseId,
      params.collectionId,
      params.key,
    );
  }

  async createEnumAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    elements: string[];
    required: boolean;
  }) {
    return this.addAttribute(
      'createEnumAttribute',
      params.databaseId,
      params.collectionId,
      params.key,
    );
  }

  async listIndexes(params: { databaseId: string; collectionId: string }) {
    const col = this.collections.get(this.colKey(params.databaseId, params.collectionId));
    if (!col) throw makeAppwriteError(404, 'Collection not found');
    return { total: col.indexes.size, indexes: Array.from(col.indexes.values()) };
  }

  async createIndex(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    type: string;
    attributes: string[];
    orders?: string[];
  }) {
    this.createCalls++;
    this.callCounts.createIndex++;
    const c = this.collections.get(this.colKey(params.databaseId, params.collectionId));
    if (!c) throw makeAppwriteError(404, 'Collection not found');
    if (c.indexes.has(params.key)) {
      throw makeAppwriteError(409, 'Index already exists');
    }
    c.indexes.set(params.key, {
      key: params.key,
      type: params.type,
      attributes: params.attributes,
      orders: params.orders,
    });
    return { key: params.key, type: params.type };
  }

  /** Inject a non-409 error to be thrown by the next call matching `method`. */
  injectFault(method: string, error: Error) {
    this.faults.set(method, error);
  }
}

function makeAppwriteError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const env = {
  databaseId: 'xreporter_test',
  databaseName: 'xreporter_test',
};

describe('runSetup', () => {
  it('creates the database, every collection, every attribute, and every index on a clean run', async () => {
    const fake = new FakeAppwrite();
    await runSetup({ client: fake, ...env, logger: silentLogger });

    expect(fake.databases.size).toBe(1);
    expect(fake.collections.size).toBe(COLLECTIONS.length);

    // Spot-check `users` collection has the documented attributes + indexes.
    const users = fake.collections.get(`${env.databaseId}/users`);
    expect(users).toBeDefined();
    expect(users?.attributes.has('xUserId')).toBe(true);
    expect(users?.attributes.has('handle')).toBe(true);
    expect(users?.attributes.has('pollIntervalMin')).toBe(true);
    expect(users?.attributes.has('digestIntervalMin')).toBe(true);
    expect(users?.attributes.has('lastLikeCursor')).toBe(true);
    expect(users?.attributes.has('lastBookmarkCursor')).toBe(true);
    expect(users?.attributes.has('status')).toBe(true);
    expect(users?.attributes.has('createdAt')).toBe(true);
    expect(users?.indexes.has('xUserId_unique')).toBe(true);
    expect(users?.indexes.has('status_key')).toBe(true);

    // Spot-check `items` compound unique + descending fetchedAt index.
    const items = fake.collections.get(`${env.databaseId}/items`);
    expect(items?.indexes.get('userId_xTweetId_unique')?.attributes).toEqual([
      'userId',
      'xTweetId',
    ]);
    expect(items?.indexes.get('userId_xTweetId_unique')?.type).toBe('unique');
    const userFetched = items?.indexes.get('userId_fetchedAt_desc');
    expect(userFetched?.orders).toContain('desc');
  });

  it('is a no-op on the second run (no errors, no new create calls)', async () => {
    const fake = new FakeAppwrite();

    await runSetup({ client: fake, ...env, logger: silentLogger });
    const callsAfterFirstRun = fake.createCalls;
    expect(callsAfterFirstRun).toBeGreaterThan(0);

    await runSetup({ client: fake, ...env, logger: silentLogger });
    expect(fake.createCalls).toBe(callsAfterFirstRun);
  });

  it('treats 409 from createDatabase as success (race-safe)', async () => {
    const fake = new FakeAppwrite();
    fake.databases.set(env.databaseId, { name: env.databaseName });
    // Now the script's create call would 409. Should be swallowed.
    await expect(
      runSetup({ client: fake, ...env, logger: silentLogger }),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-409 errors so the run aborts non-zero', async () => {
    const fake = new FakeAppwrite();
    // Force the first createDatabase to throw a 500.
    fake.createDatabase = async () => {
      throw makeAppwriteError(500, 'internal error');
    };
    await expect(
      runSetup({ client: fake, ...env, logger: silentLogger }),
    ).rejects.toThrow(/internal error/);
  });

  it('creates exactly the 5 documented collections', async () => {
    const fake = new FakeAppwrite();
    await runSetup({ client: fake, ...env, logger: silentLogger });
    const ids = Array.from(fake.collections.values()).map((c) => c.collectionId).sort();
    expect(ids).toEqual(['articles', 'digests', 'items', 'tokens', 'users']);
  });

  it('uses the unique index type for tokens.userId', async () => {
    const fake = new FakeAppwrite();
    await runSetup({ client: fake, ...env, logger: silentLogger });
    const tokens = fake.collections.get(`${env.databaseId}/tokens`);
    const idx = tokens?.indexes.get('userId_unique');
    expect(idx?.type).toBe('unique');
  });

  it('digests collection has userId+createdAt desc index', async () => {
    const fake = new FakeAppwrite();
    await runSetup({ client: fake, ...env, logger: silentLogger });
    const digests = fake.collections.get(`${env.databaseId}/digests`);
    const idx = digests?.indexes.get('userId_createdAt_desc');
    expect(idx?.attributes).toEqual(['userId', 'createdAt']);
    expect(idx?.orders?.[1]).toBe('desc');
  });
});
