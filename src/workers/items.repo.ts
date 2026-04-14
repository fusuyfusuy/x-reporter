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
  getDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
  }): Promise<Record<string, unknown> & { $id: string }>;
  updateDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
}

const COLLECTION_ID = 'items';

/**
 * Hard cap on the number of items a single digest window pulls back.
 * The `build-digest` processor feeds the result into `DigestGraph`,
 * which tokenises every article body; an unbounded scan would let one
 * pathological user (or a misconfigured cadence) produce prompts
 * large enough to blow the LLM context window. 500 is well above the
 * largest digest we expect in practice (the default daily cadence
 * caps at whatever a user can plausibly like in 24h) while still
 * fitting comfortably under every adapter's list-documents paging
 * limit.
 */
const MAX_WINDOW_ITEMS = 500;

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

  /** Lookup by Appwrite document id. Returns `null` on 404. */
  async findById(itemId: string): Promise<ItemRecord | null> {
    try {
      const doc = await this.db.getDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: itemId,
      });
      return toItemRecord(doc);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Mark an item as enriched — called by the extract-item processor
   * after all URLs for the item have been extracted (or failed in a
   * way that the processor chose to accept). Writes only the
   * `enriched` field; other attributes are untouched.
   */
  async setEnriched(itemId: string): Promise<void> {
    await this.db.updateDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: itemId,
      data: { enriched: true },
    });
  }

  /**
   * List enriched items for a user whose `fetchedAt` falls in the
   * half-open window `[start, end)`. Ordered oldest-first so the
   * downstream digest graph sees items in the sequence they were
   * ingested.
   *
   * Used by `BuildDigestProcessor` to gather the source set for a
   * digest window. The `(userId, fetchedAt desc)` and
   * `(userId, enriched)` indexes declared in
   * `scripts/setup-appwrite.ts` back the scan.
   */
  async findEnrichedInWindow(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<ItemRecord[]> {
    const result = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [
        Query.equal('userId', userId),
        Query.equal('enriched', true),
        Query.greaterThanEqual('fetchedAt', start.toISOString()),
        Query.lessThan('fetchedAt', end.toISOString()),
        Query.orderAsc('fetchedAt'),
        Query.limit(MAX_WINDOW_ITEMS),
      ],
    });
    return result.documents.map(toItemRecord);
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
  const e = err as { code?: number; type?: string };
  return e.code === 409 || e.type === 'document_already_exists';
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 404;
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
