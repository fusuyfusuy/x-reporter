import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ArticleExtractor } from '../extraction/article-extractor.port';
import { ARTICLE_EXTRACTOR } from '../extraction/extraction.module';
import { ArticlesRepo } from './articles.repo';
import { ItemsRepo } from './items.repo';

/**
 * BullMQ job handler for the `extract-item` queue.
 *
 * For each URL attached to the item the processor calls
 * `ArticleExtractor.extract` and persists the result via
 * `ArticlesRepo.create`. Per-URL failures are logged at `warn` but do
 * not fail the job — only if *every* URL for the item fails does the
 * processor rethrow, letting BullMQ retry under the queue's backoff
 * policy (see `docs/jobs.md`).
 *
 * On success the item is flipped to `enriched = true` so it becomes
 * eligible for the next digest window.
 *
 * The processor never imports BullMQ types directly; it receives a
 * structural `ExtractItemJob` and the `WorkersLifecycle` in
 * `workers.module.ts` is the only caller, same pattern as `PollXProcessor`.
 */

/** Minimal job shape — no BullMQ types in the public interface. */
export interface ExtractItemJob {
  data: { userId: string; itemId: string };
  attemptsMade: number;
}

@Injectable()
export class ExtractItemProcessor {
  private readonly logger = new Logger(ExtractItemProcessor.name);

  constructor(
    @Inject(ARTICLE_EXTRACTOR) private readonly extractor: ArticleExtractor,
    private readonly items: ItemsRepo,
    private readonly articles: ArticlesRepo,
  ) {}

  async process(job: ExtractItemJob): Promise<void> {
    const { userId, itemId } = job.data;
    const start = Date.now();

    const item = await this.items.findById(itemId);
    if (!item) {
      this.logger.warn(`skipping extract: item ${itemId} not found`);
      return;
    }
    if (item.userId !== userId) {
      // A userId mismatch means the job payload drifted away from the
      // row — treat it like a missing item rather than a retryable
      // error so the job doesn't loop forever.
      this.logger.warn(
        `skipping extract: item ${itemId} userId ${item.userId} != job ${userId}`,
      );
      return;
    }
    if (item.enriched) {
      this.logger.log(`item ${itemId} already enriched, skipping`);
      return;
    }
    if (item.urls.length === 0) {
      // Defensive: the poll-x processor already filters out items with
      // no URLs, but tolerate the edge case by marking enriched and
      // moving on. Nothing to extract.
      await this.items.setEnriched(itemId);
      return;
    }

    let successes = 0;
    let failures = 0;
    const firstError: { url: string; error: Error } | null = await this.extractAll(
      item.urls,
      itemId,
      (ok) => {
        if (ok) successes++;
        else failures++;
      },
    );

    if (successes === 0 && firstError) {
      // Every URL failed — surface the first error so BullMQ retries
      // the whole job. The attempts/backoff policy (4 / exponential
      // base 15s) is set on enqueue in `PollXProcessor`.
      throw firstError.error;
    }

    await this.items.setEnriched(itemId);

    const durationMs = Date.now() - start;
    this.logger.log('extract complete', {
      userId,
      itemId,
      attempt: job.attemptsMade + 1,
      urlCount: item.urls.length,
      successes,
      failures,
      durationMs,
    });
  }

  /**
   * Run the extractor against every URL sequentially. Sequential rather
   * than parallel keeps the processor's concurrency budget simple: the
   * per-worker concurrency (`EXTRACT_ITEM_CONCURRENCY`, default 10) is
   * already BullMQ's knob for scaling — fanning out a single item's
   * URLs on top of that would multiply outbound Firecrawl load in a
   * way ops can't predict.
   *
   * Returns the first captured error (for the "all failed" branch to
   * rethrow) and reports each outcome via the callback.
   */
  private async extractAll(
    urls: string[],
    itemId: string,
    onResult: (ok: boolean) => void,
  ): Promise<{ url: string; error: Error } | null> {
    let firstError: { url: string; error: Error } | null = null;
    for (const url of urls) {
      try {
        const article = await this.extractor.extract(url);
        await this.articles.create(itemId, article);
        onResult(true);
      } catch (err) {
        onResult(false);
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`extract failed for ${url} (item ${itemId}): ${error.message}`);
        if (!firstError) firstError = { url, error };
      }
    }
    return firstError;
  }
}
