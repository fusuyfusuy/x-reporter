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
import {
  EXTRACT_ITEM_QUEUE_NAME,
  POLL_X_QUEUE_NAME,
  REDIS_CLIENT,
} from '../queue/queue.tokens';
import { ArticlesRepo } from './articles.repo';
import { ExtractItemProcessor } from './extract-item.processor';
import { ItemsRepo } from './items.repo';
import { PollXProcessor } from './poll-x.processor';

/**
 * Owns BullMQ `Worker` instances for all processor queues.
 *
 * Registers the `poll-x` worker (#7) and the `extract-item` worker (#8).
 * A future milestone (#11 `build-digest`) adds another worker here.
 *
 * Worker creation and shutdown live in `WorkersLifecycle`, a separate
 * injectable registered as a provider. This follows the same pattern
 * `QueueModule` uses with `QueueModuleLifecycle` — and lets the
 * e2e-lite test override it to prevent workers from connecting to
 * Redis.
 */

const POLL_X_CONCURRENCY = 'POLL_X_CONCURRENCY';
const EXTRACT_ITEM_CONCURRENCY = 'EXTRACT_ITEM_CONCURRENCY';

export interface WorkerConcurrency {
  pollX: number;
  extractItem: number;
}

/**
 * Lifecycle holder that creates and tears down BullMQ Workers.
 * Overridable in tests via `Test.overrideProvider(WorkersLifecycle)`.
 */
export class WorkersLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkersLifecycle.name);
  private pollXWorker?: Worker;
  private extractItemWorker?: Worker;

  constructor(
    private readonly redis: Redis,
    private readonly concurrency: WorkerConcurrency,
    private readonly pollXProcessor: PollXProcessor,
    private readonly extractItemProcessor: ExtractItemProcessor,
  ) {}

  onModuleInit() {
    this.pollXWorker = new Worker(
      POLL_X_QUEUE_NAME,
      async (job) => this.pollXProcessor.process(job),
      {
        connection: this.redis,
        concurrency: this.concurrency.pollX,
      },
    );
    this.logger.log(`poll-x worker started (concurrency: ${this.concurrency.pollX})`);

    this.extractItemWorker = new Worker(
      EXTRACT_ITEM_QUEUE_NAME,
      async (job) => this.extractItemProcessor.process(job),
      {
        connection: this.redis,
        concurrency: this.concurrency.extractItem,
      },
    );
    this.logger.log(
      `extract-item worker started (concurrency: ${this.concurrency.extractItem})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeWorker(this.pollXWorker, 'poll-x');
    await this.closeWorker(this.extractItemWorker, 'extract-item');
  }

  private async closeWorker(worker: Worker | undefined, name: string): Promise<void> {
    if (!worker) return;
    try {
      await worker.close();
      this.logger.log(`${name} worker closed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`failed to close ${name} worker: ${message}`);
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
        ArticlesRepo,
        PollXProcessor,
        ExtractItemProcessor,
        { provide: POLL_X_CONCURRENCY, useValue: env.POLL_X_CONCURRENCY },
        { provide: EXTRACT_ITEM_CONCURRENCY, useValue: env.EXTRACT_ITEM_CONCURRENCY },
        {
          provide: WorkersLifecycle,
          useFactory: (
            redis: Redis,
            pollXConcurrency: number,
            extractItemConcurrency: number,
            pollX: PollXProcessor,
            extractItem: ExtractItemProcessor,
          ) =>
            new WorkersLifecycle(
              redis,
              { pollX: pollXConcurrency, extractItem: extractItemConcurrency },
              pollX,
              extractItem,
            ),
          inject: [
            REDIS_CLIENT,
            POLL_X_CONCURRENCY,
            EXTRACT_ITEM_CONCURRENCY,
            PollXProcessor,
            ExtractItemProcessor,
          ],
        },
      ],
    };
  }
}
