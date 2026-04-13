import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthExpiredError } from '../auth/auth.service';
import type { FetchPage, TweetItem, XSource } from '../ingestion/x-source.port';
import { X_SOURCE } from '../ingestion/ingestion.module';
import { EXTRACT_ITEM_QUEUE } from '../queue/queue.tokens';
import { UsersRepo } from '../users/users.repo';
import { ItemsRepo } from './items.repo';

/** Minimal job shape — no BullMQ types in the public interface. */
export interface PollXJob {
  data: { userId: string };
  attemptsMade: number;
}

@Injectable()
export class PollXProcessor {
  private readonly logger = new Logger(PollXProcessor.name);

  constructor(
    @Inject(X_SOURCE) private readonly xSource: XSource,
    @Inject(EXTRACT_ITEM_QUEUE)
    private readonly extractQueue: {
      add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
    },
    private readonly users: UsersRepo,
    private readonly items: ItemsRepo,
  ) {}

  async process(job: PollXJob): Promise<void> {
    const { userId } = job.data;
    const start = Date.now();

    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active') {
      this.logger.warn(`skipping poll: user ${userId} is ${user?.status ?? 'missing'}`);
      return;
    }

    let likeItems: TweetItem[];
    let lastLikeCursor: string | undefined;
    let bookmarkItems: TweetItem[];
    let lastBookmarkCursor: string | undefined;

    try {
      ({ items: likeItems, cursor: lastLikeCursor } = await this.fetchAll(
        (cursor) => this.xSource.fetchLikes(userId, cursor),
        user.lastLikeCursor,
      ));
      ({ items: bookmarkItems, cursor: lastBookmarkCursor } = await this.fetchAll(
        (cursor) => this.xSource.fetchBookmarks(userId, cursor),
        user.lastBookmarkCursor,
      ));
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        this.logger.warn(`auth expired for user ${userId}, stopping poll`);
        return;
      }
      throw err;
    }

    const likeResults = await this.items.upsertMany(userId, likeItems);
    const bookmarkResults = await this.items.upsertMany(userId, bookmarkItems);
    const allResults = [...likeResults, ...bookmarkResults];
    const allItems = [...likeItems, ...bookmarkItems];

    let extractJobsEnqueued = 0;
    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i]!;
      const item = allItems[i]!;
      if (result.isNew && item.urls.length > 0) {
        await this.extractQueue.add(
          'extract-item',
          { userId, itemId: result.id },
          {
            attempts: 4,
            backoff: { type: 'exponential', delay: 15_000 },
            removeOnComplete: { age: 86_400, count: 1000 },
            removeOnFail: { age: 604_800 },
          },
        );
        extractJobsEnqueued++;
      }
    }

    const cursors: { lastLikeCursor?: string; lastBookmarkCursor?: string } = {};
    if (lastLikeCursor !== undefined) cursors.lastLikeCursor = lastLikeCursor;
    if (lastBookmarkCursor !== undefined) cursors.lastBookmarkCursor = lastBookmarkCursor;
    if (Object.keys(cursors).length > 0) {
      await this.users.updateCursors(userId, cursors);
    }

    const durationMs = Date.now() - start;
    const newLikes = likeResults.filter((r) => r.isNew).length;
    const newBookmarks = bookmarkResults.filter((r) => r.isNew).length;
    this.logger.log('poll complete', {
      userId,
      attempt: job.attemptsMade + 1,
      durationMs,
      newLikes,
      newBookmarks,
      newItems: newLikes + newBookmarks,
      extractJobsEnqueued,
    });
  }

  /**
   * Walk all pages from a fetch function until `nextCursor` is absent.
   * Returns all collected items and the last cursor seen (for persisting).
   */
  private async fetchAll(
    fetchPage: (cursor?: string) => Promise<FetchPage>,
    initialCursor?: string,
  ): Promise<{ items: TweetItem[]; cursor?: string }> {
    const collected: TweetItem[] = [];
    let cursor: string | undefined = initialCursor;
    let lastCursor: string | undefined;

    // biome-ignore lint/correctness/noConstantCondition: pagination loop
    while (true) {
      const page = await fetchPage(cursor);
      collected.push(...page.items);
      if (page.nextCursor) {
        lastCursor = page.nextCursor;
        cursor = page.nextCursor;
      } else {
        break;
      }
    }
    return { items: collected, cursor: lastCursor };
  }
}
