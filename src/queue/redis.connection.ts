import IORedis, { type Redis } from 'ioredis';

/**
 * Result of a single Redis liveness probe. Discriminated union so callers
 * can branch without losing type information (mirrors
 * `AppwriteService.ping`'s `AppwritePingResult`).
 */
export type RedisPingResult =
  | { status: 'ok' }
  | { status: 'down'; error: string };

/**
 * Builds the process-wide `ioredis` client used as the BullMQ `connection`
 * for every `Queue` (and, in milestone #7, every `Worker`) and as the
 * Redis health probe in `HealthController`.
 *
 * Options locked at construction time:
 *
 * - `maxRetriesPerRequest: null` — BullMQ workers REQUIRE this to be
 *   `null` (or undefined) in BullMQ 5.x. Setting it here means #7 cannot
 *   forget it later. If we ever needed a request-level retry budget on a
 *   non-BullMQ caller, the right fix is a dedicated client, not loosening
 *   this one.
 *
 * - `enableReadyCheck: false` — ioredis's default ready check issues an
 *   `INFO` command before accepting application traffic, which in CI
 *   (fresh `redis-server` container) can stall Nest boot for several
 *   seconds. BullMQ does not need the ready check, so turning it off
 *   trims cold-start time.
 *
 * - `lazyConnect: true` — the client does not open a TCP socket until
 *   the first command. Keeps unit tests that construct the client
 *   (without ever running a query) from leaking file descriptors and
 *   from failing on CI boxes where Redis is not running.
 *
 * The URL is parsed by `ioredis` itself, which supports the full
 * `redis://[user:pass@]host:port[/db]` shape. Validation (URL format)
 * happens upstream in `env.ts`.
 */
export function createRedisClient(url: string): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

/**
 * Minimal structural type capturing only the `.ping()` slice of the
 * `ioredis` `Redis` class that {@link pingRedis} actually uses. Declaring
 * it locally means {@link pingRedis} can be unit-tested with a hand-rolled
 * stub that does not pull in the whole ioredis surface.
 *
 * Exported so {@link RedisHealth} (in `queue.module.ts`) can declare the
 * same dependency without re-stating the type.
 */
export interface PingableRedis {
  ping(): Promise<string>;
}

/**
 * Lightweight Redis liveness probe. Mirrors `AppwriteService.ping`:
 * never throws — any failure is converted into a
 * `{ status: 'down', error }` value so the `/health` handler can stay
 * synchronous-feeling and never leak an exception through the HTTP layer.
 *
 * Takes the pingable structural type rather than `Redis` directly so the
 * tests can hand in a stub without building a real ioredis client.
 */
export async function pingRedis(client: PingableRedis): Promise<RedisPingResult> {
  try {
    await client.ping();
    return { status: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'down',
      error: `redis ping failed: ${message}`,
    };
  }
}
