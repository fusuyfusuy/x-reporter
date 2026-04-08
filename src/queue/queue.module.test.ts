import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'bun:test';
import { Queue } from 'bullmq';
import { QueueModule } from './queue.module';
import {
  BUILD_DIGEST_QUEUE,
  EXTRACT_ITEM_QUEUE,
  POLL_X_QUEUE,
  REDIS_CLIENT,
  REDIS_HEALTH,
  type RedisHealthPort,
} from './queue.tokens';

/**
 * DI-registration sanity check for `QueueModule`.
 *
 * We do NOT talk to a real Redis here. `createRedisClient` uses
 * `lazyConnect: true`, so constructing the module resolves every provider
 * without opening a TCP socket. The queues themselves defer their own
 * connection until the first command, so `new Queue(...)` is also
 * safe at boot.
 *
 * What we assert:
 *
 *   1. Each of the three queue tokens resolves to a BullMQ `Queue`
 *      instance with the documented name (`poll-x` / `extract-item` /
 *      `build-digest`). A typo in the registration would otherwise
 *      silently ship.
 *   2. `REDIS_CLIENT` resolves to an object (the ioredis client).
 *   3. `REDIS_HEALTH` resolves to an object with a `ping()` method —
 *      the structural type `HealthController` will inject.
 *   4. `onModuleDestroy` closes without throwing. Under lazy-connect,
 *      `queue.close()` and `client.quit()` each resolve against a
 *      client that never opened a socket; that's fine, but we lock
 *      the behavior here so a future "defensive" refactor that
 *      force-connects cannot slip through.
 */

const TEST_REDIS_URL = 'redis://localhost:6379';

describe('QueueModule', () => {
  // Share one testing module across the whole describe so the afterAll
  // teardown runs exactly once. Every `it` resolves the providers from
  // the same module — we're asserting the registration, not per-request
  // state.
  const modulePromise = Test.createTestingModule({
    imports: [QueueModule.forRoot({ redisUrl: TEST_REDIS_URL })],
  }).compile();

  afterAll(async () => {
    const mod = await modulePromise;
    await mod.close();
  });

  it('registers the poll-x queue under POLL_X_QUEUE', async () => {
    const mod = await modulePromise;
    const queue = mod.get<Queue>(POLL_X_QUEUE);
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe('poll-x');
  });

  it('registers the extract-item queue under EXTRACT_ITEM_QUEUE', async () => {
    const mod = await modulePromise;
    const queue = mod.get<Queue>(EXTRACT_ITEM_QUEUE);
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe('extract-item');
  });

  it('registers the build-digest queue under BUILD_DIGEST_QUEUE', async () => {
    const mod = await modulePromise;
    const queue = mod.get<Queue>(BUILD_DIGEST_QUEUE);
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe('build-digest');
  });

  it('registers a shared Redis client under REDIS_CLIENT', async () => {
    const mod = await modulePromise;
    const client = mod.get(REDIS_CLIENT);
    expect(client).toBeDefined();
    expect(typeof (client as { ping?: unknown }).ping).toBe('function');
  });

  it('registers a Redis health helper under REDIS_HEALTH with a ping() method', async () => {
    const mod = await modulePromise;
    const health = mod.get<RedisHealthPort>(REDIS_HEALTH);
    expect(health).toBeDefined();
    expect(typeof health.ping).toBe('function');
  });

  it('shares a single Redis client across all three queues (connection reuse)', async () => {
    // The queue layer promises exactly one ioredis connection in normal
    // operation — this test locks that guarantee. Every BullMQ Queue
    // constructed by the module must receive the same `connection`
    // option (the `REDIS_CLIENT` singleton). Creating a separate client
    // per queue would work but would quadruple the socket count and
    // break the `onModuleDestroy` one-quit contract.
    const mod = await modulePromise;
    const client = mod.get(REDIS_CLIENT);
    const pollQueue = mod.get<Queue>(POLL_X_QUEUE);
    const extractQueue = mod.get<Queue>(EXTRACT_ITEM_QUEUE);
    const digestQueue = mod.get<Queue>(BUILD_DIGEST_QUEUE);
    expect(pollQueue.opts.connection).toBe(client);
    expect(extractQueue.opts.connection).toBe(client);
    expect(digestQueue.opts.connection).toBe(client);
  });
});
