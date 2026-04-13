# Poll-X Processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first BullMQ worker — a `PollXProcessor` that consumes the `poll-x` queue, fetches a user's likes/bookmarks via `XSource`, upserts items, and enqueues extraction jobs.

**Architecture:** New `WorkersModule` owns the BullMQ `Worker` lifecycle. `PollXProcessor` is a plain injectable with no BullMQ types in its public interface. A new `ItemsRepo` handles item persistence. `UsersRepo` gains cursor fields and an `updateCursors` method.

**Tech Stack:** NestJS, BullMQ (Worker), Appwrite (items collection), Bun test

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/users/users.repo.ts` | Add cursor fields to `UserRecord`, add `updateCursors` method |
| Modify | `src/users/users.repo.test.ts` | Tests for cursor fields and `updateCursors` |
| Create | `src/workers/items.repo.ts` | Appwrite adapter for `items` collection |
| Create | `src/workers/items.repo.test.ts` | Tests for `ItemsRepo` |
| Create | `src/workers/poll-x.processor.ts` | Processing logic for `poll-x` queue |
| Create | `src/workers/poll-x.processor.test.ts` | Unit tests with stub XSource |
| Create | `src/workers/workers.module.ts` | Module owning Worker lifecycle |
| Modify | `src/app.module.ts` | Register `WorkersModule` |
| Modify | `package.json` | Version bump 0.6.0 → 0.7.0 |

---

### Task 1: Add cursor fields to UserRecord

**Files:**
- Modify: `src/users/users.repo.ts`
- Modify: `src/users/users.repo.test.ts`

- [ ] **Step 1: Write failing tests for cursor fields on UserRecord**

Add to `src/users/users.repo.test.ts` at the end of the `UsersRepo.findById` describe block:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/users/users.repo.test.ts`
Expected: Two failures — `lastLikeCursor` and `lastBookmarkCursor` are not on `UserRecord`.

- [ ] **Step 3: Add cursor fields to UserRecord and toUserRecord**

In `src/users/users.repo.ts`, add to the `UserRecord` interface after `digestIntervalMin`:

```ts
  /** Opaque X pagination cursor for likes. Set by poll-x processor. */
  lastLikeCursor?: string;
  /** Opaque X pagination cursor for bookmarks. Set by poll-x processor. */
  lastBookmarkCursor?: string;
```

In the `toUserRecord` function, before the `return` statement, add:

```ts
  const lastLikeCursor = optionalStringField(doc, 'lastLikeCursor');
  const lastBookmarkCursor = optionalStringField(doc, 'lastBookmarkCursor');
```

And update the return to spread them:

```ts
  return {
    id: doc.$id,
    xUserId,
    handle,
    status,
    createdAt,
    ...(pollIntervalMin !== undefined ? { pollIntervalMin } : {}),
    ...(digestIntervalMin !== undefined ? { digestIntervalMin } : {}),
    ...(lastLikeCursor !== undefined ? { lastLikeCursor } : {}),
    ...(lastBookmarkCursor !== undefined ? { lastBookmarkCursor } : {}),
  };
```

Add the helper function after `optionalIntegerField`:

```ts
function optionalStringField(
  doc: Record<string, unknown> & { $id: string },
  key: string,
): string | undefined {
  const value = doc[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`users row ${doc.$id} has non-string ${key}: ${String(value)}`);
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/users/users.repo.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/users/users.repo.ts src/users/users.repo.test.ts
git commit -m "feat(users): add cursor fields to UserRecord"
```

---

### Task 2: Add UsersRepo.updateCursors method

**Files:**
- Modify: `src/users/users.repo.ts`
- Modify: `src/users/users.repo.test.ts`

- [ ] **Step 1: Write failing tests for updateCursors**

Add a new describe block at the end of `src/users/users.repo.test.ts`:

```ts
describe('UsersRepo.updateCursors', () => {
  it('writes lastLikeCursor and returns the updated record', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCursors(u.id, { lastLikeCursor: 'cursor-abc' });
    expect(updated.id).toBe(u.id);
    expect(updated.lastLikeCursor).toBe('cursor-abc');
    expect(updated.lastBookmarkCursor).toBeUndefined();
  });

  it('writes lastBookmarkCursor and returns the updated record', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCursors(u.id, { lastBookmarkCursor: 'cursor-xyz' });
    expect(updated.lastBookmarkCursor).toBe('cursor-xyz');
  });

  it('writes both cursors when both are supplied', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    const updated = await repo.updateCursors(u.id, {
      lastLikeCursor: 'lc',
      lastBookmarkCursor: 'bc',
    });
    expect(updated.lastLikeCursor).toBe('lc');
    expect(updated.lastBookmarkCursor).toBe('bc');
  });

  it('leaves an unspecified cursor untouched on a partial patch', async () => {
    const { repo, db } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    await repo.updateCursors(u.id, { lastLikeCursor: 'lc', lastBookmarkCursor: 'bc' });
    const after = await repo.updateCursors(u.id, { lastLikeCursor: 'lc2' });
    expect(after.lastLikeCursor).toBe('lc2');
    expect(after.lastBookmarkCursor).toBe('bc');
    const stored = db.docs.get(u.id);
    expect(stored?.lastBookmarkCursor).toBe('bc');
  });

  it('throws when the user does not exist', async () => {
    const { repo } = makeRepo();
    await expect(
      repo.updateCursors('does-not-exist', { lastLikeCursor: 'x' }),
    ).rejects.toThrow();
  });

  it('throws on an empty patch', async () => {
    const { repo } = makeRepo();
    const u = await repo.upsertByXUserId({ xUserId: '12345', handle: 'h' });
    await expect(repo.updateCursors(u.id, {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/users/users.repo.test.ts`
Expected: Failures — `updateCursors` does not exist on `UsersRepo`.

- [ ] **Step 3: Implement updateCursors**

Add to `src/users/users.repo.ts`, in the `UsersRepo` class after the `updateCadence` method. Also add `UpdateCursorsInput` interface after `UpdateCadenceInput`:

```ts
export interface UpdateCursorsInput {
  lastLikeCursor?: string;
  lastBookmarkCursor?: string;
}
```

Method:

```ts
  /**
   * Update one or both pagination cursors. Called by the poll-x processor
   * after items are persisted. Throws if the user does not exist (a cursor
   * update on a missing user is a bug, not a race condition).
   */
  async updateCursors(
    userId: string,
    patch: UpdateCursorsInput,
  ): Promise<UserRecord> {
    const data: Record<string, unknown> = {};
    if (patch.lastLikeCursor !== undefined) {
      data.lastLikeCursor = patch.lastLikeCursor;
    }
    if (patch.lastBookmarkCursor !== undefined) {
      data.lastBookmarkCursor = patch.lastBookmarkCursor;
    }
    if (Object.keys(data).length === 0) {
      throw new Error('updateCursors called with empty patch');
    }
    const updated = await this.db.updateDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: userId,
      data,
    });
    return toUserRecord(updated);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/users/users.repo.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/users/users.repo.ts src/users/users.repo.test.ts
git commit -m "feat(users): add updateCursors method to UsersRepo"
```

---

### Task 3: Create ItemsRepo

**Files:**
- Create: `src/workers/items.repo.ts`
- Create: `src/workers/items.repo.test.ts`

- [ ] **Step 1: Write the ItemsRepo test file with FakeDatabases**

Create `src/workers/items.repo.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { ItemsRepo, type ItemRecord } from './items.repo';

/**
 * In-memory fake of the Appwrite databases slice that `ItemsRepo` uses.
 * Mirrors the compound unique index `(userId, xTweetId)` from the real
 * schema by checking for duplicates on create.
 */
class FakeDatabases {
  readonly docs = new Map<string, Record<string, unknown> & { $id: string }>();

  async createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }> {
    // Enforce compound unique index (userId, xTweetId).
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/workers/items.repo.test.ts`
Expected: Failure — module `./items.repo` not found.

- [ ] **Step 3: Implement ItemsRepo**

Create `src/workers/items.repo.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ID } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';
import type { TweetItem, TweetKind } from '../ingestion/x-source.port';

export interface ItemRecord {
  id: string;
  userId: string;
  xTweetId: string;
  kind: TweetKind;
  text: string;
  authorHandle: string;
  urls: string[];
  fetchedAt: string;
  enriched: boolean;
}

interface ItemsDatabases {
  getDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
  }): Promise<Record<string, unknown> & { $id: string }>;
  createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
}

const COLLECTION_ID = 'items';

@Injectable()
export class ItemsRepo {
  private readonly databaseId: string;
  private readonly db: ItemsDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    this.db = appwrite.databases as unknown as ItemsDatabases;
  }

  /**
   * Upsert items for a user. Uses `ID.unique()` for document IDs and
   * relies on the compound unique index `(userId, xTweetId)` for dedup.
   * On 409 conflict, the item already exists — look it up and return
   * with `isNew: false`.
   */
  async upsertMany(
    userId: string,
    items: TweetItem[],
  ): Promise<Array<{ id: string; isNew: boolean }>> {
    const results: Array<{ id: string; isNew: boolean }> = [];
    const fetchedAt = new Date().toISOString();

    for (const item of items) {
      try {
        const created = await this.db.createDocument({
          databaseId: this.databaseId,
          collectionId: COLLECTION_ID,
          documentId: ID.unique(),
          data: {
            userId,
            xTweetId: item.tweetId,
            kind: item.kind,
            text: item.text,
            authorHandle: item.authorHandle,
            urls: item.urls,
            fetchedAt,
            enriched: false,
          },
        });
        results.push({ id: created.$id, isNew: true });
      } catch (err) {
        if (!isConflict(err)) throw err;
        // Item already exists — find it to get its ID.
        const existing = await this.findByUserAndTweetId(userId, item.tweetId);
        if (!existing) {
          // 409 but can't find the doc — the conflict wasn't the compound
          // index we expected. Surface the original error.
          throw err;
        }
        results.push({ id: existing.id, isNew: false });
      }
    }
    return results;
  }

  /**
   * Find an item by userId + xTweetId. Used internally for conflict
   * resolution on upsert. Returns `null` if not found.
   *
   * Since there's no way to getDocument by a compound index directly in
   * Appwrite, we need to use listDocuments. However, to keep the
   * structural interface minimal, we use a workaround: scan all docs
   * in-memory in tests. In production, this is backed by the real
   * Appwrite SDK which supports queries. For now, we do a simple
   * approach: the 409 handler already knows the item exists, so we can
   * search through the collection.
   *
   * NOTE: This method uses listDocuments which requires adding it to
   * the structural interface. Instead, we keep the interface minimal and
   * handle this in the upsert by storing a local map of created IDs.
   */
  async findByUserAndTweetId(
    _userId: string,
    _xTweetId: string,
  ): Promise<ItemRecord | null> {
    // This method is not needed in the hot path — the upsert uses a
    // different approach. Placeholder for future milestone use.
    return null;
  }
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 409;
}

function toItemRecord(doc: Record<string, unknown> & { $id: string }): ItemRecord {
  const userId = doc.userId;
  const xTweetId = doc.xTweetId;
  const kind = doc.kind;
  const text = doc.text;
  const authorHandle = doc.authorHandle;
  const urls = doc.urls;
  const fetchedAt = doc.fetchedAt;
  const enriched = doc.enriched;
  if (
    typeof userId !== 'string' ||
    typeof xTweetId !== 'string' ||
    typeof text !== 'string' ||
    typeof authorHandle !== 'string' ||
    typeof fetchedAt !== 'string'
  ) {
    throw new Error(`items row ${doc.$id} is missing required string fields`);
  }
  if (kind !== 'like' && kind !== 'bookmark') {
    throw new Error(`items row ${doc.$id} has invalid kind: ${String(kind)}`);
  }
  if (!Array.isArray(urls)) {
    throw new Error(`items row ${doc.$id} has non-array urls`);
  }
  return {
    id: doc.$id,
    userId,
    xTweetId,
    kind,
    text,
    authorHandle,
    urls: urls.map(String),
    fetchedAt,
    enriched: enriched === true,
  };
}
```

Wait — the `findByUserAndTweetId` approach is problematic. The 409 conflict handler needs to find the existing document's ID. Let me rethink.

Actually, I'll take a simpler approach: track a local `Map<string, string>` inside `upsertMany` for items we've already created in this batch, and for 409 conflicts, use `listDocuments` with a query. Let me add `listDocuments` to the structural interface.

Let me rewrite this properly.

Create `src/workers/items.repo.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ID, Query } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';
import type { TweetItem, TweetKind } from '../ingestion/x-source.port';

export interface ItemRecord {
  id: string;
  userId: string;
  xTweetId: string;
  kind: TweetKind;
  text: string;
  authorHandle: string;
  urls: string[];
  fetchedAt: string;
  enriched: boolean;
}

interface ItemsDatabases {
  createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
  listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }>;
}

const COLLECTION_ID = 'items';

@Injectable()
export class ItemsRepo {
  private readonly databaseId: string;
  private readonly db: ItemsDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    this.db = appwrite.databases as unknown as ItemsDatabases;
  }

  /**
   * Upsert items for a user. Uses `ID.unique()` for document IDs and
   * relies on the compound unique index `(userId, xTweetId)` for dedup.
   * On 409 conflict, the item already exists — query it back and return
   * with `isNew: false`.
   */
  async upsertMany(
    userId: string,
    items: TweetItem[],
  ): Promise<Array<{ id: string; isNew: boolean }>> {
    const results: Array<{ id: string; isNew: boolean }> = [];
    const fetchedAt = new Date().toISOString();

    for (const item of items) {
      try {
        const created = await this.db.createDocument({
          databaseId: this.databaseId,
          collectionId: COLLECTION_ID,
          documentId: ID.unique(),
          data: {
            userId,
            xTweetId: item.tweetId,
            kind: item.kind,
            text: item.text,
            authorHandle: item.authorHandle,
            urls: item.urls,
            fetchedAt,
            enriched: false,
          },
        });
        results.push({ id: created.$id, isNew: true });
      } catch (err) {
        if (!isConflict(err)) throw err;
        const existing = await this.findByUserAndTweetId(userId, item.tweetId);
        if (!existing) throw err;
        results.push({ id: existing.id, isNew: false });
      }
    }
    return results;
  }

  /** Query by compound key. Returns `null` on miss. */
  async findByUserAndTweetId(
    userId: string,
    xTweetId: string,
  ): Promise<ItemRecord | null> {
    const result = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [Query.equal('userId', userId), Query.equal('xTweetId', xTweetId)],
    });
    if (result.total === 0 || result.documents.length === 0) return null;
    return toItemRecord(result.documents[0]!);
  }
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 409;
}

function toItemRecord(doc: Record<string, unknown> & { $id: string }): ItemRecord {
  const userId = doc.userId;
  const xTweetId = doc.xTweetId;
  const kind = doc.kind;
  const text = doc.text;
  const authorHandle = doc.authorHandle;
  const urls = doc.urls;
  const fetchedAt = doc.fetchedAt;
  const enriched = doc.enriched;
  if (
    typeof userId !== 'string' ||
    typeof xTweetId !== 'string' ||
    typeof text !== 'string' ||
    typeof authorHandle !== 'string' ||
    typeof fetchedAt !== 'string'
  ) {
    throw new Error(`items row ${doc.$id} is missing required string fields`);
  }
  if (kind !== 'like' && kind !== 'bookmark') {
    throw new Error(`items row ${doc.$id} has invalid kind: ${String(kind)}`);
  }
  if (!Array.isArray(urls)) {
    throw new Error(`items row ${doc.$id} has non-array urls`);
  }
  return {
    id: doc.$id,
    userId,
    xTweetId,
    kind,
    text,
    authorHandle,
    urls: urls.map(String),
    fetchedAt,
    enriched: enriched === true,
  };
}
```

- [ ] **Step 4: Update the test fake to support listDocuments**

The test `FakeDatabases` needs a `listDocuments` that supports `Query.equal` filtering. Update the test file's `FakeDatabases` class to add:

```ts
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
```

And add the `parseEqualQuery` helper (same as in `users.repo.test.ts`):

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/workers/items.repo.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean.

- [ ] **Step 7: Commit**

```bash
git add src/workers/items.repo.ts src/workers/items.repo.test.ts
git commit -m "feat(workers): add ItemsRepo for items collection"
```

---

### Task 4: Create PollXProcessor

**Files:**
- Create: `src/workers/poll-x.processor.ts`
- Create: `src/workers/poll-x.processor.test.ts`

- [ ] **Step 1: Write the test file with fakes and the first test**

Create `src/workers/poll-x.processor.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { AuthExpiredError } from '../auth/auth.service';
import type { FetchPage, TweetItem, XSource } from '../ingestion/x-source.port';
import type { UserRecord } from '../users/users.repo';
import { PollXProcessor } from './poll-x.processor';
import type { ItemRecord } from './items.repo';

/** Stub XSource returning canned pages. */
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

/** Fake UsersRepo tracking calls. */
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

/** Fake ItemsRepo tracking upserts. */
class FakeItemsRepo {
  upserted: Array<{ userId: string; items: TweetItem[] }> = [];
  private nextId = 1;
  private knownTweetIds = new Set<string>();

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

/** Fake extract-item queue tracking added jobs. */
class FakeExtractQueue {
  jobs: Array<{ name: string; data: unknown }> = [];

  async add(name: string, data: unknown): Promise<void> {
    this.jobs.push({ name, data });
  }
}

/** Fake logger collecting log calls. */
class FakeLogger {
  logs: Array<{ level: string; msg: string; context?: Record<string, unknown> }> = [];

  info(msg: string, context?: Record<string, unknown>) {
    this.logs.push({ level: 'info', msg, context });
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
    logger as never,
  );

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

    // Items upserted: 2 likes + 1 bookmark.
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

    // Should NOT throw — AuthExpiredError is caught.
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

    // Pre-mark tw-1 as known.
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

    // Only tw-2 is new, so only one extract job.
    expect(extractQueue.jobs).toHaveLength(1);
    expect((extractQueue.jobs[0]!.data as { itemId: string }).itemId).toBe('item-2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/workers/poll-x.processor.test.ts`
Expected: Failure — module `./poll-x.processor` not found.

- [ ] **Step 3: Implement PollXProcessor**

Create `src/workers/poll-x.processor.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthExpiredError } from '../auth/auth.service';
import type { FetchPage, TweetItem, XSource } from '../ingestion/x-source.port';
import { X_SOURCE } from '../ingestion/ingestion.module';
import { EXTRACT_ITEM_QUEUE } from '../queue/queue.tokens';
import { UsersRepo } from '../users/users.repo';
import { ItemsRepo } from './items.repo';

/** Minimal job shape — no BullMQ types in the public interface. */
export interface PollXJob {
  data: { userId: string };
  attemptsMade: number;
}

@Injectable()
export class PollXProcessor {
  private readonly logger = new Logger(PollXProcessor.name);

  constructor(
    @Inject(X_SOURCE) private readonly xSource: XSource,
    @Inject(EXTRACT_ITEM_QUEUE) private readonly extractQueue: { add(name: string, data: unknown): Promise<unknown> },
    private readonly users: UsersRepo,
    private readonly items: ItemsRepo,
  ) {}

  async process(job: PollXJob): Promise<void> {
    const { userId } = job.data;
    const start = Date.now();

    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active') {
      this.logger.warn(`skipping poll: user ${userId} is ${user?.status ?? 'missing'}`);
      return;
    }

    let likeItems: TweetItem[];
    let lastLikeCursor: string | undefined;
    let bookmarkItems: TweetItem[];
    let lastBookmarkCursor: string | undefined;

    try {
      ({ items: likeItems, cursor: lastLikeCursor } = await this.fetchAll(
        (cursor) => this.xSource.fetchLikes(userId, cursor),
        user.lastLikeCursor,
      ));
      ({ items: bookmarkItems, cursor: lastBookmarkCursor } = await this.fetchAll(
        (cursor) => this.xSource.fetchBookmarks(userId, cursor),
        user.lastBookmarkCursor,
      ));
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        this.logger.warn(`auth expired for user ${userId}, stopping poll`);
        return;
      }
      throw err;
    }

    const likeResults = await this.items.upsertMany(userId, likeItems);
    const bookmarkResults = await this.items.upsertMany(userId, bookmarkItems);
    const allResults = [...likeResults, ...bookmarkResults];
    const allItems = [...likeItems, ...bookmarkItems];

    let extractJobsEnqueued = 0;
    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i]!;
      const item = allItems[i]!;
      if (result.isNew && item.urls.length > 0) {
        await this.extractQueue.add('extract-item', {
          userId,
          itemId: result.id,
        });
        extractJobsEnqueued++;
      }
    }

    const cursors: { lastLikeCursor?: string; lastBookmarkCursor?: string } = {};
    if (lastLikeCursor !== undefined) cursors.lastLikeCursor = lastLikeCursor;
    if (lastBookmarkCursor !== undefined) cursors.lastBookmarkCursor = lastBookmarkCursor;
    if (Object.keys(cursors).length > 0) {
      await this.users.updateCursors(userId, cursors);
    }

    const durationMs = Date.now() - start;
    this.logger.info('poll complete', {
      userId,
      attempt: job.attemptsMade,
      durationMs,
      newLikes: likeResults.filter((r) => r.isNew).length,
      newBookmarks: bookmarkResults.filter((r) => r.isNew).length,
      extractJobsEnqueued,
    });
  }

  /**
   * Walk all pages from a fetch function until `nextCursor` is absent.
   * Returns all collected items and the last cursor seen (for persisting).
   */
  private async fetchAll(
    fetchPage: (cursor?: string) => Promise<FetchPage>,
    initialCursor?: string,
  ): Promise<{ items: TweetItem[]; cursor?: string }> {
    const collected: TweetItem[] = [];
    let cursor: string | undefined = initialCursor;
    let lastCursor: string | undefined;

    // biome-ignore lint/correctness/noConstantCondition: pagination loop
    while (true) {
      const page = await fetchPage(cursor);
      collected.push(...page.items);
      if (page.nextCursor) {
        lastCursor = page.nextCursor;
        cursor = page.nextCursor;
      } else {
        break;
      }
    }
    return { items: collected, cursor: lastCursor };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/workers/poll-x.processor.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add src/workers/poll-x.processor.ts src/workers/poll-x.processor.test.ts
git commit -m "feat(workers): add PollXProcessor for poll-x queue"
```

---

### Task 5: Create WorkersModule

**Files:**
- Create: `src/workers/workers.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Create WorkersModule**

Create `src/workers/workers.module.ts`:

```ts
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env';
import {
  EXTRACT_ITEM_QUEUE,
  POLL_X_QUEUE_NAME,
  REDIS_CLIENT,
} from '../queue/queue.tokens';
import { PollXProcessor } from './poll-x.processor';
import { ItemsRepo } from './items.repo';

/**
 * Owns BullMQ `Worker` instances for all processor queues.
 *
 * This milestone (#7) registers only the `poll-x` worker. Future
 * milestones (#8 `extract-item`, #11 `build-digest`) add their
 * workers here.
 *
 * The module creates the `Worker` in `onModuleInit` and closes it
 * gracefully in `onModuleDestroy`, ensuring in-flight jobs finish
 * before the Redis connection is reclaimed by `QueueModule`.
 */
@Module({})
export class WorkersModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersModule.name);
  private pollXWorker?: Worker;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly pollXProcessor: PollXProcessor,
  ) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkersModule,
      providers: [
        ItemsRepo,
        PollXProcessor,
        {
          provide: 'POLL_X_CONCURRENCY',
          useValue: env.POLL_X_CONCURRENCY,
        },
      ],
      exports: [],
    };
  }

  onModuleInit() {
    this.pollXWorker = new Worker(
      POLL_X_QUEUE_NAME,
      async (job) => this.pollXProcessor.process(job),
      {
        connection: this.redis,
        concurrency: 5,
      },
    );
    this.logger.log(`poll-x worker started (concurrency: 5)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollXWorker) {
      try {
        await this.pollXWorker.close();
        this.logger.log('poll-x worker closed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`failed to close poll-x worker: ${message}`);
      }
    }
  }
}
```

Wait — there's a problem. The concurrency should come from the `forRoot(env)` call, but the module instance that runs `onModuleInit` can't easily access the value passed to the static method. Let me restructure to use a provider for concurrency.

```ts
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  POLL_X_QUEUE_NAME,
  REDIS_CLIENT,
} from '../queue/queue.tokens';
import type { Env } from '../config/env';
import { PollXProcessor } from './poll-x.processor';
import { ItemsRepo } from './items.repo';

const POLL_X_CONCURRENCY = 'POLL_X_CONCURRENCY';

@Module({})
export class WorkersModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersModule.name);
  private pollXWorker?: Worker;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(POLL_X_CONCURRENCY) private readonly concurrency: number,
    private readonly pollXProcessor: PollXProcessor,
  ) {}

  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkersModule,
      providers: [
        ItemsRepo,
        PollXProcessor,
        { provide: POLL_X_CONCURRENCY, useValue: env.POLL_X_CONCURRENCY },
      ],
    };
  }

  onModuleInit() {
    this.pollXWorker = new Worker(
      POLL_X_QUEUE_NAME,
      async (job) => this.pollXProcessor.process(job),
      {
        connection: this.redis,
        concurrency: this.concurrency,
      },
    );
    this.logger.log(`poll-x worker started (concurrency: ${this.concurrency})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollXWorker) {
      try {
        await this.pollXWorker.close();
        this.logger.log('poll-x worker closed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`failed to close poll-x worker: ${message}`);
      }
    }
  }
}
```

- [ ] **Step 2: Register WorkersModule in AppModule**

In `src/app.module.ts`, add the import:

```ts
import { WorkersModule } from './workers/workers.module';
```

Add `WorkersModule.forRoot(env)` to the imports array after `IngestionModule.forRoot(env)`:

```ts
        IngestionModule.forRoot(env),
        WorkersModule.forRoot(env),
```

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 5: Run lint**

Run: `bunx biome lint .`
Expected: Clean (or fix any issues).

- [ ] **Step 6: Commit**

```bash
git add src/workers/workers.module.ts src/app.module.ts
git commit -m "feat(workers): add WorkersModule with poll-x Worker lifecycle"
```

---

### Task 6: Version bump and final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.6.0"` to `"version": "0.7.0"`.

- [ ] **Step 2: Run full verification**

```bash
bun test && bunx tsc --noEmit && bunx biome lint .
```

Expected: All green.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.7.0"
```
