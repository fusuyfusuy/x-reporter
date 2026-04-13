import {
  type DynamicModule,
  Global,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisClient, pingRedis, type RedisPingResult } from './redis.connection';
import {
  BUILD_DIGEST_QUEUE,
  BUILD_DIGEST_QUEUE_NAME,
  EXTRACT_ITEM_QUEUE,
  EXTRACT_ITEM_QUEUE_NAME,
  POLL_X_QUEUE,
  POLL_X_QUEUE_NAME,
  REDIS_CLIENT,
  REDIS_HEALTH,
  type RedisHealthPort,
} from './queue.tokens';

/**
 * `QueueModule` owns the BullMQ lifecycle for the entire process.
 *
 * Register exactly once from `AppModule` via `QueueModule.forRoot({...})`.
 * The module is `@Global()` so consumers (`ScheduleService`, the
 * worker modules arriving in #7 / #8 / #11, `HealthController`) can
 * inject the queue / client / health tokens without importing this
 * module anywhere else.
 *
 * Providers:
 *
 * | Token                 | Value                              | Lifetime |
 * |-----------------------|------------------------------------|----------|
 * | `REDIS_CLIENT`        | shared `ioredis` client            | process  |
 * | `REDIS_HEALTH`        | `{ ping() }` helper over the client| process  |
 * | `POLL_X_QUEUE`        | `Queue('poll-x')`                  | process  |
 * | `EXTRACT_ITEM_QUEUE`  | `Queue('extract-item')`            | process  |
 * | `BUILD_DIGEST_QUEUE`  | `Queue('build-digest')`            | process  |
 *
 * Design choices locked here:
 *
 * 1. **Single shared ioredis client.** All three queues share the same
 *    `connection` option, and the Redis health probe uses the same
 *    client. The process has exactly one Redis TCP socket in normal
 *    operation, not one per queue. `onModuleDestroy` quits that
 *    socket once.
 *
 * 2. **Tokens, not classes.** Consumers `@Inject(POLL_X_QUEUE)` rather
 *    than importing `Queue` and declaring a concrete type. That keeps
 *    BullMQ types from leaking past `src/queue/` and `src/schedule/`,
 *    per the hexagonal rule in `docs/swe-config.json`.
 *
 * 3. **No `Worker` instances.** This milestone (#5) stands up the
 *    producers only. Registering `BullMQ.Worker`s is deferred to
 *    #7 / #8 / #11 which each own their processor logic.
 *
 * 4. **Graceful shutdown.** `onModuleDestroy` closes all three
 *    queues before quitting the client. Queue close must run first
 *    because BullMQ's internal scripts can still be in-flight when
 *    the module tears down — quitting the client first would leak
 *    half-finished Lua operations.
 */

/**
 * Thin helper bound to the shared `ioredis` client. Lives here (not in
 * `redis.connection.ts`) so the `REDIS_CLIENT` singleton created in the
 * module factory is captured by closure — the helper does not need a
 * separate `Inject` chain to reach the same client.
 */
class RedisHealth implements RedisHealthPort {
  constructor(private readonly client: Redis) {}

  async ping(): Promise<RedisPingResult> {
    return pingRedis(this.client);
  }
}

/**
 * Options for {@link QueueModule.forRoot}. Accepts the minimum surface
 * area (`redisUrl`) so the module never has to import `Env` directly.
 * `AppModule.forRoot()` passes `env.REDIS_URL` in; tests pass a literal.
 */
export interface QueueModuleOptions {
  redisUrl: string;
}

/**
 * Internal holder for the module-destroy cleanup. The providers
 * themselves are plain objects (Queue instances, ioredis client), so
 * Nest has no hook to call into them — we register a dedicated
 * Injectable whose `onModuleDestroy` drains them in the right order.
 */
class QueueModuleLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(QueueModuleLifecycle.name);

  constructor(
    private readonly client: Redis,
    private readonly queues: Queue[],
  ) {}

  async onModuleDestroy(): Promise<void> {
    // 1. Close all queues first. Queue.close() waits for pending
    //    BullMQ operations (script evaluations, in-flight `add`s)
    //    to finish, then releases the internal connection wrapper.
    //    Running this before the client quit prevents half-finished
    //    Lua scripts from being truncated mid-execution.
    //
    //    Note: under `lazyConnect: true`, calling `queue.close()`
    //    against a queue whose shared connection never opened may
    //    itself trigger a one-shot connect-then-fail inside BullMQ
    //    (the close path issues a script eval which forces lazy
    //    connect). The status check below runs *after* this loop on
    //    purpose, so it sees the post-loop reality rather than the
    //    pre-loop snapshot.
    for (const queue of this.queues) {
      try {
        await queue.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`failed to close queue ${queue.name}: ${message}`);
      }
    }

    // 2. Quit the shared client only if it has (or had) a live socket
    //    to close. ioredis exposes the connection lifecycle as a
    //    `status` string:
    //      - `wait`                       — never connected (lazyConnect)
    //      - `connecting` / `connect`     — TCP open or in flight
    //      - `ready`                      — accepting commands
    //      - `close` / `end`              — already terminated
    //
    //    We skip `quit()` for both the never-connected and the
    //    already-terminated states: calling `quit()` on either of
    //    those leaks an unhandled "Connection is closed" rejection
    //    from ioredis (the close handler races the quit promise),
    //    which we have no useful action for during teardown.
    //
    //    Swallow errors on the live-quit path either way: if quit
    //    fails, the process is terminating anyway, and throwing
    //    would mask any earlier cleanup failures we want Nest to
    //    surface first.
    const status = this.client.status;
    const needsQuit = status !== 'wait' && status !== 'end' && status !== 'close';
    if (!needsQuit) {
      return;
    }
    try {
      await this.client.quit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`failed to quit redis client: ${message}`);
    }
  }
}

@Global()
@Module({})
export class QueueModule {
  static forRoot(options: QueueModuleOptions): DynamicModule {
    // Build the shared client eagerly so all queues and the health
    // probe reference the same instance. `createRedisClient` sets
    // `lazyConnect: true`, so no TCP socket opens here — that happens
    // on the first command.
    const client = createRedisClient(options.redisUrl);

    // Each queue is constructed with the shared client as its
    // `connection`. Passing the already-built client (rather than an
    // options object) is what makes `queue.opts.connection === client`
    // — BullMQ's own reference is what the module-destroy lifecycle
    // later drains.
    const pollXQueue = new Queue(POLL_X_QUEUE_NAME, { connection: client });
    const extractItemQueue = new Queue(EXTRACT_ITEM_QUEUE_NAME, {
      connection: client,
    });
    const buildDigestQueue = new Queue(BUILD_DIGEST_QUEUE_NAME, {
      connection: client,
    });

    const redisHealth = new RedisHealth(client);

    const lifecycleProvider = {
      provide: QueueModuleLifecycle,
      useFactory: () =>
        new QueueModuleLifecycle(client, [
          pollXQueue,
          extractItemQueue,
          buildDigestQueue,
        ]),
    };

    return {
      module: QueueModule,
      providers: [
        { provide: REDIS_CLIENT, useValue: client },
        { provide: REDIS_HEALTH, useValue: redisHealth },
        { provide: POLL_X_QUEUE, useValue: pollXQueue },
        { provide: EXTRACT_ITEM_QUEUE, useValue: extractItemQueue },
        { provide: BUILD_DIGEST_QUEUE, useValue: buildDigestQueue },
        lifecycleProvider,
      ],
      exports: [
        REDIS_CLIENT,
        REDIS_HEALTH,
        POLL_X_QUEUE,
        EXTRACT_ITEM_QUEUE,
        BUILD_DIGEST_QUEUE,
      ],
    };
  }
}
