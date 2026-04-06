import { Injectable } from '@nestjs/common';
import { ID, Query } from 'node-appwrite';
import { AppwriteService } from '../appwrite/appwrite.service';

/**
 * Thin adapter over `AppwriteService.databases` for the `users` collection.
 *
 * Lives under `src/users/` because the `/me` controller and the rest of
 * the cadence settings (issue #4) will live alongside it. This milestone
 * (#3) only needs `upsertByXUserId` and `setStatus` for the OAuth flow,
 * plus two read helpers (`findById`, `findByXUserId`) used by tests and
 * `AuthService.getValidAccessToken`.
 *
 * The repo is the **only** place outside `AppwriteService` itself and the
 * setup script that touches `appwrite.databases` for users. Its public
 * surface is plain TypeScript shapes — no `Models.Document<T>` envelopes
 * leak. This is what keeps the hexagonal rule "no Appwrite SDK types in
 * any module's public surface" intact.
 */

/** Allowed values for the `users.status` enum (mirrors data-model.md). */
export type UserStatus = 'active' | 'auth_expired' | 'paused';

/** Plain shape returned by every `UsersRepo` method. No SDK envelope. */
export interface UserRecord {
  id: string;
  xUserId: string;
  handle: string;
  status: UserStatus;
  createdAt: string;
}

/**
 * Structural type capturing only the slice of `appwrite.databases` that
 * `UsersRepo` actually uses. Declared here so the in-memory test fake can
 * implement the same surface without caring about the rest of the SDK.
 */
interface UsersDatabases {
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

const COLLECTION_ID = 'users';

@Injectable()
export class UsersRepo {
  private readonly databaseId: string;
  private readonly db: UsersDatabases;

  constructor(appwrite: AppwriteService) {
    this.databaseId = appwrite.databaseId;
    // Cast through `unknown` because the SDK's `Databases` class is wider
    // than the `UsersDatabases` slice we depend on. The slice exists so
    // the test fake doesn't need to implement the entire SDK.
    this.db = appwrite.databases as unknown as UsersDatabases;
  }

  /**
   * Create-or-update a user keyed by their X numeric user id.
   *
   * Idempotent: a second call with the same `xUserId` returns the same
   * `UserRecord`. If the existing user has `status='auth_expired'`, the
   * status is reset to `'active'` (a successful re-sign-in clears the
   * expired flag). The handle is also refreshed in case the user changed
   * it on X.
   */
  async upsertByXUserId(input: { xUserId: string; handle: string }): Promise<UserRecord> {
    const existing = await this.findByXUserId(input.xUserId);
    if (existing) {
      const needsUpdate =
        existing.handle !== input.handle || existing.status === 'auth_expired';
      if (!needsUpdate) return existing;
      const updated = await this.db.updateDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: existing.id,
        data: {
          handle: input.handle,
          status: 'active',
        },
      });
      return toUserRecord(updated);
    }

    const documentId = ID.unique();
    const createdAt = new Date().toISOString();
    const created = await this.db.createDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId,
      data: {
        xUserId: input.xUserId,
        handle: input.handle,
        status: 'active',
        createdAt,
      },
    });
    return toUserRecord(created);
  }

  /**
   * Update only the `status` field for the given user. Used by
   * `AuthService.getValidAccessToken` when refresh fails so the next
   * scheduled poll knows to skip the user until they re-auth.
   */
  async setStatus(userId: string, status: UserStatus): Promise<UserRecord> {
    const updated = await this.db.updateDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: userId,
      data: { status },
    });
    return toUserRecord(updated);
  }

  /** Lookup by Appwrite document id. Returns `null` on 404. */
  async findById(userId: string): Promise<UserRecord | null> {
    try {
      const doc = await this.db.getDocument({
        databaseId: this.databaseId,
        collectionId: COLLECTION_ID,
        documentId: userId,
      });
      return toUserRecord(doc);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Lookup by X numeric user id (the unique business key). */
  async findByXUserId(xUserId: string): Promise<UserRecord | null> {
    const result = await this.db.listDocuments({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      queries: [Query.equal('xUserId', xUserId)],
    });
    if (result.total === 0 || result.documents.length === 0) return null;
    return toUserRecord(result.documents[0]!);
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number };
  return e.code === 404;
}

/**
 * Convert an Appwrite document envelope into the plain `UserRecord` shape.
 * Validates the fields the rest of the auth code relies on so a malformed
 * row aborts early instead of producing a half-typed object.
 */
function toUserRecord(doc: Record<string, unknown> & { $id: string }): UserRecord {
  const xUserId = doc.xUserId;
  const handle = doc.handle;
  const status = doc.status;
  const createdAt = doc.createdAt;
  if (typeof xUserId !== 'string' || typeof handle !== 'string') {
    throw new Error(`users row ${doc.$id} is missing xUserId/handle`);
  }
  if (status !== 'active' && status !== 'auth_expired' && status !== 'paused') {
    throw new Error(`users row ${doc.$id} has invalid status: ${String(status)}`);
  }
  if (typeof createdAt !== 'string') {
    throw new Error(`users row ${doc.$id} is missing createdAt`);
  }
  return {
    id: doc.$id,
    xUserId,
    handle,
    status,
    createdAt,
  };
}
