import { Injectable } from '@nestjs/common';
import { ID, Query } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';
import type { ExtractedArticle } from '../extraction/article-extractor.port';

/**
 * Thin adapter over `AppwriteService.databases` for the `articles`
 * collection. Mirrors the `ItemsRepo` pattern: the only SDK slice we
 * depend on is declared as a structural type so tests can swap in an
 * in-memory fake.
 */

export interface ArticleRecord {
  id: string;
  itemId: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  byline?: string;
  siteName?: string;
  content: string;
  extractedAt: string;
  extractor: string;
}

interface ArticlesDatabases {
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

const COLLECTION_ID = 'articles';

@Injectable()
export class ArticlesRepo {
  private readonly databaseId: string;
  private readonly db: ArticlesDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    this.db = appwrite.databases as unknown as ArticlesDatabases;
  }

  /**
   * Persist one extracted article. If an article row already exists for
   * the same `(itemId, url)` pair (returned by Appwrite as a 409 or
   * `document_already_exists`), the existing row wins and the method
   * resolves without throwing — re-running the extractor for the same
   * URL should be idempotent.
   *
   * There is no compound unique index on `(itemId, url)` today; the
   * fallback is a listDocuments dedup probe done before insert, which
   * is cheap in v1 (at most a few URLs per item). A future schema
   * change can tighten this to a DB-level unique constraint.
   */
  async create(itemId: string, article: ExtractedArticle): Promise<ArticleRecord> {
    const existing = await this.findByItemIdAndUrl(itemId, article.url);
    if (existing) return existing;

    const extractedAt = new Date().toISOString();
    const data: Record<string, unknown> = {
      itemId,
      url: article.url,
      content: article.content,
      extractedAt,
      extractor: article.extractor,
    };
    if (article.canonicalUrl !== undefined) data.canonicalUrl = article.canonicalUrl;
    if (article.title !== undefined) data.title = article.title;
    if (article.byline !== undefined) data.byline = article.byline;
    if (article.siteName !== undefined) data.siteName = article.siteName;

    try {
      const created = await this.db.createDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: ID.unique(),
        data,
      });
      return toArticleRecord(created);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // A race with a concurrent writer — re-query and return the winner.
      const winner = await this.findByItemIdAndUrl(itemId, article.url);
      if (!winner) throw err;
      return winner;
    }
  }

  async findByItemIdAndUrl(itemId: string, url: string): Promise<ArticleRecord | null> {
    const result = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [Query.equal('itemId', itemId), Query.equal('url', url)],
    });
    if (result.total === 0 || result.documents.length === 0) return null;
    return toArticleRecord(result.documents[0]!);
  }
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; type?: string };
  return e.code === 409 || e.type === 'document_already_exists';
}

function toArticleRecord(doc: Record<string, unknown> & { $id: string }): ArticleRecord {
  const itemId = doc.itemId;
  const url = doc.url;
  const content = doc.content;
  const extractedAt = doc.extractedAt;
  const extractor = doc.extractor;
  if (
    typeof itemId !== 'string' ||
    typeof url !== 'string' ||
    typeof content !== 'string' ||
    typeof extractedAt !== 'string' ||
    typeof extractor !== 'string'
  ) {
    throw new Error(`articles row ${doc.$id} is missing required string fields`);
  }
  const record: ArticleRecord = {
    id: doc.$id,
    itemId,
    url,
    content,
    extractedAt,
    extractor,
  };
  const canonicalUrl = doc.canonicalUrl;
  const title = doc.title;
  const byline = doc.byline;
  const siteName = doc.siteName;
  if (typeof canonicalUrl === 'string') record.canonicalUrl = canonicalUrl;
  if (typeof title === 'string') record.title = title;
  if (typeof byline === 'string') record.byline = byline;
  if (typeof siteName === 'string') record.siteName = siteName;
  return record;
}
