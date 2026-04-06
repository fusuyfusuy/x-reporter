import { Injectable } from '@nestjs/common';
import { Client, Databases } from 'node-appwrite';
import type { Env } from '../config/env';

/**
 * Result of a single Appwrite health probe. Discriminated union so callers
 * can branch without losing type information.
 */
export type AppwritePingResult =
  | { status: 'ok' }
  | { status: 'down'; error: string };

/**
 * Thin wrapper around `node-appwrite`. The constructor is the only place in
 * the codebase that imports the SDK directly; everything else consumes
 * `AppwriteService` and never sees raw SDK types on its own surface.
 *
 * Why a thin wrapper instead of a hexagonal port + adapter pair:
 * `docs/interfaces.md` is explicit that Appwrite is "a foundation we're
 * committing to" — not a swap-point. The constraint that matters is that no
 * domain layer module ever imports from `node-appwrite`. This file holds
 * that line.
 */
@Injectable()
export class AppwriteService {
  private readonly client: Client;
  private _databases: Databases;
  private readonly _databaseId: string;

  constructor(env: Env) {
    this.client = new Client()
      .setEndpoint(env.APPWRITE_ENDPOINT)
      .setProject(env.APPWRITE_PROJECT_ID)
      .setKey(env.APPWRITE_API_KEY);
    this._databases = new Databases(this.client);
    this._databaseId = env.APPWRITE_DATABASE_ID;
  }

  /**
   * The configured database id (defaults to `xreporter`). Exposed as a
   * getter so the bootstrap script and ping helper don't have to thread
   * `Env` through.
   */
  get databaseId(): string {
    return this._databaseId;
  }

  /**
   * The underlying typed `Databases` SDK handle. Returned so the bootstrap
   * script (and only the bootstrap script) can drive collection/attribute/
   * index creation directly. Application code MUST NOT reach for this; add
   * a typed helper method on `AppwriteService` instead.
   */
  get databases(): Databases {
    return this._databases;
  }

  /**
   * Lightweight liveness probe. Performs a single `databases.get` against
   * the configured database id. Never throws — converts any failure into
   * a `{ status: 'down', error }` value so the `/health` handler can stay
   * synchronous-feeling.
   */
  async ping(): Promise<AppwritePingResult> {
    try {
      await this._databases.get({ databaseId: this._databaseId });
      return { status: 'ok' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'down',
        error: `appwrite ping failed for database "${this._databaseId}": ${message}`,
      };
    }
  }

  /**
   * Test-only seam. Lets unit tests inject a fake `Databases` handle so
   * `ping()` can be exercised without a real Appwrite instance. Production
   * code MUST NOT call this.
   *
   * @internal
   */
  __setDatabasesForTesting(databases: Databases): void {
    this._databases = databases;
  }
}
