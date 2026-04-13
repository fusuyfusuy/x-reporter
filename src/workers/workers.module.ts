import {
  type DynamicModule,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env';
import { POLL_X_QUEUE_NAME, REDIS_CLIENT } from '../queue/queue.tokens';
import { ItemsRepo } from './items.repo';
import { PollXProcessor } from './poll-x.processor';

/**
 * Owns BullMQ `Worker` instances for all processor queues.
 *
 * This milestone (#7) registers only the `poll-x` worker. Future
 * milestones (#8 `extract-item`, #11 `build-digest`) add their
 * workers here.
 *
 * Worker creation and shutdown live in `WorkersLifecycle`, a separate
 * injectable registered as a provider. This follows the same pattern
 * `QueueModule` uses with `QueueModuleLifecycle` — and lets the
 * e2e-lite test override it to prevent workers from connecting to
 * Redis.
 */

const POLL_X_CONCURRENCY = 'POLL_X_CONCURRENCY';

/**
 * Lifecycle holder that creates and tears down BullMQ Workers.
 * Overridable in tests via `Test.overrideProvider(WorkersLifecycle)`.
 */
export class WorkersLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersLifecycle.name);
  private pollXWorker?: Worker;

  constructor(
    private readonly redis: Redis,
    private readonly concurrency: number,
    private readonly pollXProcessor: PollXProcessor,
  ) {}

  onModuleInit() {
    this.pollXWorker = new Worker(
      POLL_X_QUEUE_NAME,
      async (job) => this.pollXProcessor.process(job),
      {
        connection: this.redis,
        concurrency: this.concurrency,
      },
    );
    this.logger.log(`poll-x worker started (concurrency: ${this.concurrency})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollXWorker) {
      try {
        await this.pollXWorker.close();
        this.logger.log('poll-x worker closed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`failed to close poll-x worker: ${message}`);
      }
    }
  }
}

@Module({})
export class WorkersModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkersModule,
      providers: [
        ItemsRepo,
        PollXProcessor,
        { provide: POLL_X_CONCURRENCY, useValue: env.POLL_X_CONCURRENCY },
        {
          provide: WorkersLifecycle,
          useFactory: (redis: Redis, concurrency: number, processor: PollXProcessor) =>
            new WorkersLifecycle(redis, concurrency, processor),
          inject: [REDIS_CLIENT, POLL_X_CONCURRENCY, PollXProcessor],
        },
      ],
    };
  }
}
