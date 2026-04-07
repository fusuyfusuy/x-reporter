import { Injectable } from '@nestjs/common';
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
   * Create-or-update the tokens row for the given user. Idempotent and
   * race-free: the document id is `userId` itself, so two concurrent calls
   * for the same user can never create two rows. The first call wins on
   * `createDocument`; the second hits a 409 and falls through to
   * `updateDocument`.
   *
   * Using a deterministic id (instead of `ID.unique()` + a `userId_unique`
   * index lookup) is what makes this fully concurrency-safe — the previous
   * "list, then create-or-update" pattern had a TOCTOU window where two
   * concurrent first-time sign-ins for the same user could both observe
   * "no row" and one would 409.
   *
   * `accessToken` and `refreshToken` MUST already be ciphertext from
   * `src/common/crypto.ts#encrypt`. The repo never inspects the values.
   */
  async upsertForUser(input: TokenRecord): Promise<TokenRecord> {
    const data = {
      userId: input.userId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      scope: input.scope,
    };
    try {
      const created = await this.db.createDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: input.userId,
        data,
      });
      return toTokenRecord(created);
    } catch (err) {
      if (!isConflict(err)) throw err;
      const updated = await this.db.updateDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: input.userId,
        data: {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
          scope: input.scope,
        },
      });
      return toTokenRecord(updated);
    }
  }

  /** Returns the (still-encrypted) tokens row for the user, or `null`. */
  async findByUserId(userId: string): Promise<TokenRecord | null> {
    try {
      const doc = await this.db.getDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: userId,
      });
      return toTokenRecord(doc);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 409;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 404;
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
