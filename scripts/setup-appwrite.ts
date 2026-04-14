/**
 * scripts/setup-appwrite.ts
 *
 * Idempotent bootstrap for the Appwrite schema described in
 * `docs/data-model.md`. Run with `bun run scripts/setup-appwrite.ts` (or
 * `bun run setup:appwrite`).
 *
 * Behavior:
 *   - Creates the `xreporter` database if absent.
 *   - Creates each collection (`users`, `tokens`, `items`, `articles`,
 *     `digests`) if absent.
 *   - Ensures every documented attribute exists, in the documented order.
 *   - After attributes settle (`status === 'available'`), ensures every
 *     documented index exists.
 *   - Treats HTTP 409 (already exists) as success at every step. Re-running
 *     the script after a clean run is a no-op.
 *
 * Why a typed `SetupClient` interface instead of taking `AppwriteService`
 * directly: idempotency is the contract, and contracts deserve unit tests.
 * The interface is the smallest surface that lets us swap a real
 * `node-appwrite` `Databases` for an in-memory fake in tests, without
 * leaking SDK types beyond this file.
 */

import { Databases as AppwriteDatabases, Client } from 'node-appwrite';
import { loadEnv } from '../src/config/env';

// ────────────────────────────────────────────────────────────────────────────
// Types: the slice of `node-appwrite`'s Databases service we depend on.
// Kept structural so a fake test double can satisfy it without inheritance.
// ────────────────────────────────────────────────────────────────────────────

export interface SetupClient {
  getDatabase(params: { databaseId: string }): Promise<unknown>;
  createDatabase(params: { databaseId: string; name: string }): Promise<unknown>;

  getCollection(params: { databaseId: string; collectionId: string }): Promise<unknown>;
  createCollection(params: {
    databaseId: string;
    collectionId: string;
    name: string;
    permissions?: string[];
  }): Promise<unknown>;

  listAttributes(params: {
    databaseId: string;
    collectionId: string;
  }): Promise<{ total: number; attributes: Array<{ key: string; status?: string }> }>;

  createStringAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    size: number;
    required: boolean;
    array?: boolean;
  }): Promise<unknown>;

  createIntegerAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
    min?: number;
    max?: number;
    xdefault?: number;
  }): Promise<unknown>;

  createBooleanAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
    xdefault?: boolean;
  }): Promise<unknown>;

  createDatetimeAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    required: boolean;
  }): Promise<unknown>;

  createEnumAttribute(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    elements: string[];
    required: boolean;
  }): Promise<unknown>;

  listIndexes(params: {
    databaseId: string;
    collectionId: string;
  }): Promise<{ total: number; indexes: Array<{ key: string }> }>;

  createIndex(params: {
    databaseId: string;
    collectionId: string;
    key: string;
    type: string;
    attributes: string[];
    orders?: string[];
  }): Promise<unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// Schema definitions — exact mirror of docs/data-model.md.
// When the schema changes, update both files in the same PR.
// ────────────────────────────────────────────────────────────────────────────

type AttributeSpec =
  | { kind: 'string'; key: string; size: number; required: boolean; array?: boolean }
  | { kind: 'integer'; key: string; required: boolean; min?: number; xdefault?: number }
  | { kind: 'boolean'; key: string; required: boolean; xdefault?: boolean }
  | { kind: 'datetime'; key: string; required: boolean }
  | { kind: 'enum'; key: string; elements: string[]; required: boolean };

type IndexSpec = {
  key: string;
  type: 'key' | 'unique' | 'fulltext';
  attributes: string[];
  orders?: Array<'asc' | 'desc'>;
};

interface CollectionSpec {
  collectionId: string;
  name: string;
  attributes: AttributeSpec[];
  indexes: IndexSpec[];
}

export const COLLECTIONS: CollectionSpec[] = [
  {
    collectionId: 'users',
    name: 'Users',
    attributes: [
      { kind: 'string', key: 'xUserId', size: 64, required: true },
      { kind: 'string', key: 'handle', size: 64, required: true },
      { kind: 'integer', key: 'pollIntervalMin', required: false, min: 5, xdefault: 60 },
      { kind: 'integer', key: 'digestIntervalMin', required: false, min: 15, xdefault: 1440 },
      { kind: 'string', key: 'lastLikeCursor', size: 256, required: false },
      { kind: 'string', key: 'lastBookmarkCursor', size: 256, required: false },
      {
        kind: 'enum',
        key: 'status',
        elements: ['active', 'auth_expired', 'paused'],
        required: true,
      },
      { kind: 'datetime', key: 'createdAt', required: true },
    ],
    indexes: [
      { key: 'xUserId_unique', type: 'unique', attributes: ['xUserId'] },
      { key: 'status_key', type: 'key', attributes: ['status'] },
    ],
  },
  {
    collectionId: 'tokens',
    name: 'Tokens',
    attributes: [
      { kind: 'string', key: 'userId', size: 64, required: true },
      { kind: 'string', key: 'accessToken', size: 4096, required: true },
      { kind: 'string', key: 'refreshToken', size: 4096, required: true },
      { kind: 'datetime', key: 'expiresAt', required: true },
      { kind: 'string', key: 'scope', size: 512, required: true },
    ],
    indexes: [{ key: 'userId_unique', type: 'unique', attributes: ['userId'] }],
  },
  {
    collectionId: 'items',
    name: 'Items',
    attributes: [
      { kind: 'string', key: 'userId', size: 64, required: true },
      { kind: 'string', key: 'xTweetId', size: 64, required: true },
      { kind: 'enum', key: 'kind', elements: ['like', 'bookmark'], required: true },
      { kind: 'string', key: 'text', size: 4096, required: true },
      { kind: 'string', key: 'authorHandle', size: 64, required: true },
      { kind: 'string', key: 'urls', size: 2048, required: false, array: true },
      { kind: 'datetime', key: 'fetchedAt', required: true },
      { kind: 'boolean', key: 'enriched', required: false, xdefault: false },
    ],
    indexes: [
      {
        key: 'userId_xTweetId_unique',
        type: 'unique',
        attributes: ['userId', 'xTweetId'],
      },
      {
        key: 'userId_fetchedAt_desc',
        type: 'key',
        attributes: ['userId', 'fetchedAt'],
        orders: ['asc', 'desc'],
      },
      {
        key: 'userId_enriched_key',
        type: 'key',
        attributes: ['userId', 'enriched'],
      },
    ],
  },
  {
    collectionId: 'articles',
    name: 'Articles',
    attributes: [
      { kind: 'string', key: 'itemId', size: 64, required: true },
      { kind: 'string', key: 'url', size: 2048, required: true },
      { kind: 'string', key: 'canonicalUrl', size: 2048, required: false },
      { kind: 'string', key: 'title', size: 512, required: false },
      { kind: 'string', key: 'byline', size: 256, required: false },
      { kind: 'string', key: 'siteName', size: 256, required: false },
      { kind: 'string', key: 'content', size: 65535, required: true },
      { kind: 'datetime', key: 'extractedAt', required: true },
      { kind: 'string', key: 'extractor', size: 64, required: true },
    ],
    indexes: [
      { key: 'itemId_key', type: 'key', attributes: ['itemId'] },
      { key: 'canonicalUrl_key', type: 'key', attributes: ['canonicalUrl'] },
      // Compound unique index that backs `ArticlesRepo.create`'s 409
      // recovery branch: a concurrent writer racing on the same
      // (itemId, url) pair will trip this constraint and the repo will
      // re-query for the winner.
      { key: 'itemId_url_unique', type: 'unique', attributes: ['itemId', 'url'] },
    ],
  },
  {
    collectionId: 'digests',
    name: 'Digests',
    attributes: [
      { kind: 'string', key: 'userId', size: 64, required: true },
      { kind: 'datetime', key: 'windowStart', required: true },
      { kind: 'datetime', key: 'windowEnd', required: true },
      { kind: 'string', key: 'markdown', size: 65535, required: true },
      { kind: 'string', key: 'itemIds', size: 64, required: true, array: true },
      { kind: 'string', key: 'model', size: 128, required: true },
      { kind: 'integer', key: 'tokensIn', required: true, min: 0 },
      { kind: 'integer', key: 'tokensOut', required: true, min: 0 },
      { kind: 'datetime', key: 'createdAt', required: true },
    ],
    indexes: [
      {
        key: 'userId_createdAt_desc',
        type: 'key',
        attributes: ['userId', 'createdAt'],
        orders: ['asc', 'desc'],
      },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Idempotency helpers.
// ────────────────────────────────────────────────────────────────────────────

/** Returns true if the error looks like an Appwrite "already exists" 409. */
function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; type?: string };
  return e.code === 409 || e.type === 'document_already_exists';
}

/** Returns true if the error looks like an Appwrite 404. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number };
  return e.code === 404;
}

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export interface RunSetupOptions {
  client: SetupClient;
  databaseId: string;
  databaseName: string;
  logger?: Logger;
  /**
   * Tuning knobs for `waitForAttributesAvailable`. Exposed primarily so unit
   * tests can drive the wait loop to completion (or to its failure case)
   * without sleeping for 15+ seconds. Production callers should leave these
   * unset and accept the defaults.
   */
  attributeWait?: {
    maxAttempts?: number;
    intervalMs?: number;
  };
}

/**
 * Idempotent bootstrap entry point. Tests call this directly with a fake
 * `SetupClient`. The real CLI entry (bottom of this file) wires it up to
 * the live `node-appwrite` SDK.
 */
export async function runSetup(opts: RunSetupOptions): Promise<void> {
  const { client, databaseId, databaseName } = opts;
  const log = opts.logger ?? consoleLogger;
  const wait = opts.attributeWait;

  // 1. Database
  await ensureDatabase(client, databaseId, databaseName, log);

  // 2. Collections + attributes + indexes
  for (const col of COLLECTIONS) {
    await ensureCollection(client, databaseId, col, log);
    await ensureAttributes(client, databaseId, col, log, wait);
    await ensureIndexes(client, databaseId, col, log);
  }
}

async function ensureDatabase(
  client: SetupClient,
  databaseId: string,
  databaseName: string,
  log: Logger,
): Promise<void> {
  try {
    await client.getDatabase({ databaseId });
    log.info(`[skipped] database "${databaseId}" already exists`);
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      // If we can't tell whether it exists, fall through to create — a 409
      // there will be swallowed and any other error will surface.
    }
  }
  try {
    await client.createDatabase({ databaseId, name: databaseName });
    log.info(`[created] database "${databaseId}"`);
  } catch (err) {
    if (isConflict(err)) {
      log.info(`[skipped] database "${databaseId}" (race: 409)`);
      return;
    }
    throw err;
  }
}

async function ensureCollection(
  client: SetupClient,
  databaseId: string,
  spec: CollectionSpec,
  log: Logger,
): Promise<void> {
  try {
    await client.getCollection({ databaseId, collectionId: spec.collectionId });
    log.info(`[skipped] collection "${spec.collectionId}" already exists`);
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      // fall through
    }
  }
  try {
    await client.createCollection({
      databaseId,
      collectionId: spec.collectionId,
      name: spec.name,
    });
    log.info(`[created] collection "${spec.collectionId}"`);
  } catch (err) {
    if (isConflict(err)) {
      log.info(`[skipped] collection "${spec.collectionId}" (race: 409)`);
      return;
    }
    throw err;
  }
}

async function ensureAttributes(
  client: SetupClient,
  databaseId: string,
  spec: CollectionSpec,
  log: Logger,
  wait?: { maxAttempts?: number; intervalMs?: number },
): Promise<void> {
  const existing = await client
    .listAttributes({ databaseId, collectionId: spec.collectionId })
    .then((r) => new Set(r.attributes.map((a) => a.key)))
    .catch((err) => {
      if (isNotFound(err)) return new Set<string>();
      throw err;
    });

  for (const attr of spec.attributes) {
    if (existing.has(attr.key)) {
      log.info(`[skipped] ${spec.collectionId}.${attr.key}`);
      continue;
    }
    try {
      await createAttribute(client, databaseId, spec.collectionId, attr);
      log.info(`[created] ${spec.collectionId}.${attr.key} (${attr.kind})`);
    } catch (err) {
      if (isConflict(err)) {
        log.info(`[skipped] ${spec.collectionId}.${attr.key} (race: 409)`);
        continue;
      }
      throw err;
    }
  }

  // Wait for any newly-created attributes to be available before any caller
  // tries to index them. Polls listAttributes until every documented key is
  // status === 'available'. The fake in tests reports available immediately,
  // so this loop exits on the first iteration there.
  await waitForAttributesAvailable(
    client,
    databaseId,
    spec,
    log,
    wait?.maxAttempts,
    wait?.intervalMs,
  );
}

async function createAttribute(
  client: SetupClient,
  databaseId: string,
  collectionId: string,
  attr: AttributeSpec,
): Promise<void> {
  switch (attr.kind) {
    case 'string':
      await client.createStringAttribute({
        databaseId,
        collectionId,
        key: attr.key,
        size: attr.size,
        required: attr.required,
        array: attr.array,
      });
      return;
    case 'integer':
      await client.createIntegerAttribute({
        databaseId,
        collectionId,
        key: attr.key,
        required: attr.required,
        min: attr.min,
        xdefault: attr.xdefault,
      });
      return;
    case 'boolean':
      await client.createBooleanAttribute({
        databaseId,
        collectionId,
        key: attr.key,
        required: attr.required,
        xdefault: attr.xdefault,
      });
      return;
    case 'datetime':
      await client.createDatetimeAttribute({
        databaseId,
        collectionId,
        key: attr.key,
        required: attr.required,
      });
      return;
    case 'enum':
      await client.createEnumAttribute({
        databaseId,
        collectionId,
        key: attr.key,
        elements: attr.elements,
        required: attr.required,
      });
      return;
  }
}

async function waitForAttributesAvailable(
  client: SetupClient,
  databaseId: string,
  spec: CollectionSpec,
  _log: Logger,
  maxAttempts: number = 30,
  intervalMs: number = 500,
): Promise<void> {
  const wantedKeys = new Set(spec.attributes.map((a) => a.key));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const list = await client.listAttributes({
      databaseId,
      collectionId: spec.collectionId,
    });
    const ready = list.attributes.filter(
      (a) => wantedKeys.has(a.key) && (a.status === undefined || a.status === 'available'),
    );
    if (ready.length >= wantedKeys.size) return;
    if (attempt === maxAttempts) {
      const pending = Array.from(wantedKeys)
        .filter((k) => !ready.find((r) => r.key === k))
        .join(', ');
      throw new Error(
        `attributes for "${spec.collectionId}" still not available after ${maxAttempts} attempts: ${pending}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function ensureIndexes(
  client: SetupClient,
  databaseId: string,
  spec: CollectionSpec,
  log: Logger,
): Promise<void> {
  const existing = await client
    .listIndexes({ databaseId, collectionId: spec.collectionId })
    .then((r) => new Set(r.indexes.map((i) => i.key)))
    .catch((err) => {
      if (isNotFound(err)) return new Set<string>();
      throw err;
    });

  for (const idx of spec.indexes) {
    if (existing.has(idx.key)) {
      log.info(`[skipped] ${spec.collectionId}#${idx.key}`);
      continue;
    }
    try {
      await client.createIndex({
        databaseId,
        collectionId: spec.collectionId,
        key: idx.key,
        type: idx.type,
        attributes: idx.attributes,
        orders: idx.orders,
      });
      log.info(`[created] ${spec.collectionId}#${idx.key} (${idx.type})`);
    } catch (err) {
      if (isConflict(err)) {
        log.info(`[skipped] ${spec.collectionId}#${idx.key} (race: 409)`);
        continue;
      }
      throw err;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry. Importing this file in tests does NOT auto-run the CLI; the
// `if (import.meta.main)` guard keeps the side effect contained.
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const sdkClient = new Client()
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT_ID)
    .setKey(env.APPWRITE_API_KEY);
  const databases = new AppwriteDatabases(sdkClient);

  // The real SDK's `Databases` already matches `SetupClient` structurally;
  // the cast is purely a TS aid because the SDK return types are wider.
  await runSetup({
    client: databases as unknown as SetupClient,
    databaseId: env.APPWRITE_DATABASE_ID,
    databaseName: env.APPWRITE_DATABASE_ID,
  });
  console.log('appwrite setup complete');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('appwrite setup failed:', err);
    process.exit(1);
  });
}
