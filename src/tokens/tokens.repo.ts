import { Injectable } from '@nestjs/common';
import { ID, Query } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';

/**
 * Thin adapter over `AppwriteService.databases` for the `tokens`
 * collection.
 *
 * Lives under `src/tokens/` so the rest of the system can find it without
 * being entangled with the auth controller. Like `UsersRepo`, this is the
 * **only** module outside `AppwriteService` and the bootstrap script that
 * touches `appwrite.databases` for tokens.
 *
 * IMPORTANT: this repo never sees plaintext tokens. It accepts and returns
 * already-encrypted strings. Encryption / decryption happens in
 * `AuthService` using `src/common/crypto.ts`. Keeping the repo
 * crypto-agnostic means a future maintainer cannot accidentally write a
 * code path that bypasses encryption.
 */

export interface TokenRecord {
  /** FK → `users.$id`. Unique. */
  userId: string;
  /** AES-256-GCM ciphertext (`base64(iv):base64(ct+tag)`). */
  accessToken: string;
  /** AES-256-GCM ciphertext (`base64(iv):base64(ct+tag)`). */
  refreshToken: string;
  /** ISO-8601 timestamp when the access token expires. */
  expiresAt: string;
  /** Space-separated list of granted scopes. */
  scope: string;
}

interface TokensDatabases {
  listDocuments(params: {
    databaseId: string;
    collectionId: string;
    queries?: string[];
  }): Promise<{ total: number; documents: Array<Record<string, unknown> & { $id: string }> }>;
  createDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
  updateDocument(params: {
    databaseId: string;
    collectionId: string;
    documentId: string;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown> & { $id: string }>;
}

const COLLECTION_ID = 'tokens';

@Injectable()
export class TokensRepo {
  private readonly databaseId: string;
  private readonly db: TokensDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    this.db = appwrite.databases as unknown as TokensDatabases;
  }

  /**
   * Create-or-update the tokens row for the given user. Idempotent: a
   * second call for the same user updates the existing row in place
   * (the `userId_unique` index in Appwrite enforces this at the DB level
   * too, but we look up first to avoid relying on a race-prone "create
   * then catch 409 then update" pattern).
   *
   * `accessToken` and `refreshToken` MUST already be ciphertext from
   * `src/common/crypto.ts#encrypt`. The repo never inspects the values.
   */
  async upsertForUser(input: TokenRecord): Promise<TokenRecord> {
    const list = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [Query.equal('userId', input.userId)],
    });
    if (list.total > 0 && list.documents.length > 0) {
      const existing = list.documents[0]!;
      const updated = await this.db.updateDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: existing.$id,
        data: {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
          scope: input.scope,
        },
      });
      return toTokenRecord(updated);
    }
    const created = await this.db.createDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: ID.unique(),
      data: {
        userId: input.userId,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        scope: input.scope,
      },
    });
    return toTokenRecord(created);
  }

  /** Returns the (still-encrypted) tokens row for the user, or `null`. */
  async findByUserId(userId: string): Promise<TokenRecord | null> {
    const list = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [Query.equal('userId', userId)],
    });
    if (list.total === 0 || list.documents.length === 0) return null;
    return toTokenRecord(list.documents[0]!);
  }
}

function toTokenRecord(doc: Record<string, unknown> & { $id: string }): TokenRecord {
  const userId = doc.userId;
  const accessToken = doc.accessToken;
  const refreshToken = doc.refreshToken;
  const expiresAt = doc.expiresAt;
  const scope = doc.scope;
  if (
    typeof userId !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof scope !== 'string'
  ) {
    throw new Error(`tokens row ${doc.$id} is missing required fields`);
  }
  return { userId, accessToken, refreshToken, expiresAt, scope };
}
