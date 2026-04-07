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
  /**
   * Optional in the DB row (see `data-model.md` — both cadence fields
   * are optional at the schema level so the documented defaults apply
   * to never-patched users). The `/me` controller substitutes the
   * documented defaults (60 / 1440) before responding so clients always
   * see numbers, not `undefined`.
   */
  pollIntervalMin?: number;
  digestIntervalMin?: number;
}

/**
 * Patch payload for {@link UsersRepo.updateCadence}. Both fields are
 * optional but at least one MUST be provided — the repo throws on an
 * empty patch so a no-op write never reaches Appwrite. The HTTP layer
 * (zod schema in `users.controller.ts`) is the primary gate; this
 * check is belt-and-braces.
 */
export interface UpdateCadenceInput {
  pollIntervalMin?: number;
  digestIntervalMin?: number;
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
      return this.applyUpsertUpdate(existing, input);
    }

    // No existing row → try to create one. If two concurrent first-time
    // sign-ins for the same X user race here, the `xUserId_unique` index in
    // Appwrite will reject the loser with a 409. Catch that case, re-query
    // the row the winner created, and apply the same update path so the
    // method stays idempotent under concurrency.
    const documentId = ID.unique();
    const createdAt = new Date().toISOString();
    try {
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
    } catch (err) {
      if (!isConflict(err)) throw err;
      const winner = await this.findByXUserId(input.xUserId);
      if (!winner) {
        // 409 with no row to read back means the constraint that fired was
        // not the unique-xUserId one — surface the original error.
        throw err;
      }
      return this.applyUpsertUpdate(winner, input);
    }
  }

  /**
   * Shared "row already exists, reconcile with the requested handle/status"
   * branch used by both the happy path and the post-conflict re-read path.
   */
  private async applyUpsertUpdate(
    existing: UserRecord,
    input: { xUserId: string; handle: string },
  ): Promise<UserRecord> {
    const handleChanged = existing.handle !== input.handle;
    const reviveAuth = existing.status === 'auth_expired';
    if (!handleChanged && !reviveAuth) return existing;
    // Only flip status to 'active' when reviving an auth_expired row. A
    // paused user who happened to rename their X handle must stay paused
    // — `paused` is an explicit user/admin choice, not something a re-auth
    // should silently undo.
    const data: Record<string, unknown> = { handle: input.handle };
    if (reviveAuth) data.status = 'active';
    const updated = await this.db.updateDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: existing.id,
      data,
    });
    return toUserRecord(updated);
  }

  /**
   * Update one or both cadence fields. Returns the post-update record.
   *
   * Only the keys explicitly present in `patch` are forwarded to
   * Appwrite — passing `undefined` for the unspecified field would
   * clobber a previously stored value, silently flipping the user back
   * to the documented default. The HTTP boundary (`UsersController`)
   * already enforces the value constraints (`pollIntervalMin >= 5`,
   * `digestIntervalMin >= 15`, integers, at least one field) via zod;
   * the only check the repo itself performs is the empty-patch guard,
   * so a misuse from another caller fails loud instead of issuing a
   * pointless write.
   */
  async updateCadence(
    userId: string,
    patch: UpdateCadenceInput,
  ): Promise<UserRecord> {
    const data: Record<string, unknown> = {};
    if (patch.pollIntervalMin !== undefined) {
      data.pollIntervalMin = patch.pollIntervalMin;
    }
    if (patch.digestIntervalMin !== undefined) {
      data.digestIntervalMin = patch.digestIntervalMin;
    }
    if (Object.keys(data).length === 0) {
      throw new Error('updateCadence called with empty patch');
    }
    const updated = await this.db.updateDocument({
      databaseId: this.databaseId,
      collectionId: COLLECTION_ID,
      documentId: userId,
      data,
    });
    return toUserRecord(updated);
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

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: number }).code === 409;
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
  // Cadence fields are optional in the schema (data-model.md).
  // `undefined` and `null` are both treated as "unset" — Appwrite
  // returns `null` for attributes that were never written, and we
  // want the controller to fall through to the documented defaults
  // (60 / 1440) in that case rather than 500. Anything else (string,
  // float, boolean, etc.) is treated as a corrupt row and aborts
  // loudly so a hand-edited document can't smuggle a non-integer
  // into the controller's response.
  const pollIntervalMin = optionalIntegerField(doc, 'pollIntervalMin');
  const digestIntervalMin = optionalIntegerField(doc, 'digestIntervalMin');
  return {
    id: doc.$id,
    xUserId,
    handle,
    status,
    createdAt,
    ...(pollIntervalMin !== undefined ? { pollIntervalMin } : {}),
    ...(digestIntervalMin !== undefined ? { digestIntervalMin } : {}),
  };
}

function optionalIntegerField(
  doc: Record<string, unknown> & { $id: string },
  key: string,
): number | undefined {
  const value = doc[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`users row ${doc.$id} has non-integer ${key}: ${String(value)}`);
  }
  return value;
}
