/**
 * DI tokens for the queue module.
 *
 * All consumers of the queue layer (today: `ScheduleService`; tomorrow:
 * the worker modules in #7 / #8 / #11) inject BullMQ `Queue` instances
 * and Redis helpers by SYMBOLIC TOKEN, never by importing the BullMQ or
 * `ioredis` classes directly. That is how the hexagonal containment rule
 * from `docs/swe-config.json` stays intact: BullMQ + ioredis types live
 * only in `src/queue/` and `src/schedule/`, and every boundary between
 * the queue module and the rest of the app goes through one of the
 * tokens below.
 *
 * Tokens are plain strings because TypeScript interfaces do not exist at
 * runtime and Nest's `@Inject(...)` accepts a string token out of the
 * box. The string values are deliberately uppercase + underscored so a
 * grep across the codebase for `POLL_X_QUEUE` hits only the DI wiring,
 * never the literal queue name `poll-x`.
 */

/** Injection token for the BullMQ `Queue` instance backing `poll-x`. */
export const POLL_X_QUEUE = 'POLL_X_QUEUE';

/** Injection token for the BullMQ `Queue` instance backing `extract-item`. */
export const EXTRACT_ITEM_QUEUE = 'EXTRACT_ITEM_QUEUE';

/** Injection token for the BullMQ `Queue` instance backing `build-digest`. */
export const BUILD_DIGEST_QUEUE = 'BUILD_DIGEST_QUEUE';

/** Injection token for the shared process-wide `ioredis` client. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Injection token for the {@link RedisHealth} helper. `HealthController`
 * injects this instead of `REDIS_CLIENT` so the `/health` handler never
 * imports `ioredis` directly — the hexagonal rule extends to the health
 * layer. The helper's only method is `ping()`.
 */
export const REDIS_HEALTH = 'REDIS_HEALTH';

/**
 * Literal union of the queue names used over the wire (in Redis keys,
 * `jobs.md`, and the BullMQ `Queue` constructor). Exported so tests and
 * specs can enforce the list without reaching into the queue-module
 * internals. Keep this in sync with the queue instances registered in
 * `queue.module.ts`.
 */
export type QueueName = 'poll-x' | 'extract-item' | 'build-digest';

/**
 * Raw queue name constants, so the module registration and any future
 * worker module share one source of truth. Using the constants (instead
 * of free-floating strings) means a typo in a queue name produces a
 * TypeScript compile error on the consumer side.
 */
export const POLL_X_QUEUE_NAME: QueueName = 'poll-x';
export const EXTRACT_ITEM_QUEUE_NAME: QueueName = 'extract-item';
export const BUILD_DIGEST_QUEUE_NAME: QueueName = 'build-digest';

/**
 * Shape of the {@link REDIS_HEALTH} helper. A class would work too but
 * exporting the type here lets the test harness for `HealthController`
 * build a plain-object fake without reaching into the queue module's
 * implementation file.
 */
export interface RedisHealthPort {
  ping(): Promise<
    | { status: 'ok' }
    | { status: 'down'; error: string }
  >;
}
