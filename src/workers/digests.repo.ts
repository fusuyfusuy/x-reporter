import { Injectable } from '@nestjs/common';
import { ID, Query } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';

/**
 * Thin adapter over `AppwriteService.databases` for the `digests`
 * collection. Mirrors the `ItemsRepo` / `ArticlesRepo` patterns: the
 * only SDK slice we depend on is declared as a structural type so tests
 * can swap in an in-memory fake.
 *
 * Write path: `BuildDigestProcessor.create` persists one row per
 * successful graph run.
 *
 * Read path: `DigestsService` backs `GET /digests` (paginated list,
 * newest first, trimmed to a `preview`) and `GET /digests/:id` (full
 * row). Both reads constrain by `userId` so a malicious caller cannot
 * read another user's digests by guessing an id.
 */

export interface DigestRecord {
  id: string;
  userId: string;
  windowStart: string;
  windowEnd: string;
  markdown: string;
  itemIds: string[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export interface CreateDigestInput {
  userId: string;
  windowStart: string;
  windowEnd: string;
  markdown: string;
  itemIds: string[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ListDigestsInput {
  userId: string;
  limit: number;
  /** Document id to resume after (exclusive). */
  cursor?: string;
}

export interface ListDigestsResult {
  items: DigestRecord[];
  nextCursor?: string;
}

interface DigestsDatabases {
  createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
  getDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
  }): Promise<Record<string, unknown> & { $id: string }>;
  listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }>;
}

const COLLECTION_ID = 'digests';

@Injectable()
export class DigestsRepo {
  private readonly databaseId: string;
  private readonly db: DigestsDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    this.db = appwrite.databases as unknown as DigestsDatabases;
  }

  /** Persist one digest row and return the parsed record. */
  async create(input: CreateDigestInput): Promise<DigestRecord> {
    const createdAt = new Date().toISOString();
    const created = await this.db.createDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: ID.unique(),
      data: {
        userId: input.userId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        markdown: input.markdown,
        itemIds: input.itemIds,
        model: input.model,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        createdAt,
      },
    });
    return toDigestRecord(created);
  }

  /**
   * Look up a digest by id, scoped to the owning user. Returns `null`
   * both when the row doesn't exist and when it belongs to someone
   * else — the controller collapses both to a 404 so callers cannot
   * probe for other users' digest ids.
   */
  async findByIdAndUser(
    digestId: string,
    userId: string,
  ): Promise<DigestRecord | null> {
    try {
      const doc = await this.db.getDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: digestId,
      });
      const record = toDigestRecord(doc);
      if (record.userId !== userId) return null;
      return record;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Paginated list for `GET /digests`, newest first. Pagination is
   * cursor-based on the document id rather than offset-based so
   * in-flight inserts don't shift the window under the caller. We
   * fetch `limit + 1` rows so a non-empty `nextCursor` is returned iff
   * there is at least one more row beyond the page.
   *
   * The `userId, createdAt` descending index (see
   * `scripts/setup-appwrite.ts`) backs the sort.
   */
  async listByUser(input: ListDigestsInput): Promise<ListDigestsResult> {
    const queries: string[] = [
      Query.equal('userId', input.userId),
      Query.orderDesc('createdAt'),
      Query.limit(input.limit + 1),
    ];
    if (input.cursor) queries.push(Query.cursorAfter(input.cursor));
    const result = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries,
    });
    const all = result.documents.map(toDigestRecord);
    if (all.length <= input.limit) {
      return { items: all };
    }
    const page = all.slice(0, input.limit);
    const last = page[page.length - 1]!;
    return { items: page, nextCursor: last.id };
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 404;
}

function toDigestRecord(doc: Record<string, unknown> & { $id: string }): DigestRecord {
  const userId = doc.userId;
  const windowStart = doc.windowStart;
  const windowEnd = doc.windowEnd;
  const markdown = doc.markdown;
  const itemIds = doc.itemIds;
  const model = doc.model;
  const tokensIn = doc.tokensIn;
  const tokensOut = doc.tokensOut;
  const createdAt = doc.createdAt;
  if (
    typeof userId !== 'string' ||
    typeof windowStart !== 'string' ||
    typeof windowEnd !== 'string' ||
    typeof markdown !== 'string' ||
    typeof model !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error(`digests row ${doc.$id} is missing required string fields`);
  }
  if (!Array.isArray(itemIds)) {
    throw new Error(`digests row ${doc.$id} has non-array itemIds`);
  }
  if (typeof tokensIn !== 'number' || typeof tokensOut !== 'number') {
    throw new Error(`digests row ${doc.$id} has non-numeric token fields`);
  }
  return {
    id: doc.$id,
    userId,
    windowStart,
    windowEnd,
    markdown,
    itemIds: itemIds.map(String),
    model,
    tokensIn,
    tokensOut,
    createdAt,
  };
}
