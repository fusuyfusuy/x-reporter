import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DigestGraph } from '../digest/graph/digest.graph';
import type { EnrichedItem } from '../digest/graph/digest-state';
import {
  DEFAULT_DIGEST_INTERVAL_MIN,
} from '../users/cadence.constants';
import { UsersRepo } from '../users/users.repo';
import { ArticlesRepo, type ArticleRecord } from './articles.repo';
import { DigestsRepo } from './digests.repo';
import { ItemsRepo, type ItemRecord } from './items.repo';

/**
 * BullMQ job handler for the `build-digest` queue.
 *
 * Lifecycle (see `docs/jobs.md#builddigestprocessor`):
 *
 *   1. Validate the payload at the worker boundary with zod. Malformed
 *      jobs are non-recoverable (retry won't fix a missing field), so
 *      log and return — no throw.
 *   2. Load the user. If missing or not `active`, skip: a digest for a
 *      deleted / paused / auth-expired user is meaningless.
 *   3. Resolve the window: `windowEnd = data.windowEnd ?? now`,
 *      `windowStart = data.windowStart ?? windowEnd - digestIntervalMin`.
 *   4. Load enriched items in `[windowStart, windowEnd)` and the
 *      article rows that belong to them.
 *   5. If there are zero enriched items, log and return — no empty
 *      digest row. This is the "no-op on empty window" acceptance
 *      criterion in issue #11.
 *   6. Assemble `EnrichedItem[]` and call `DigestGraph.run`.
 *   7. Persist one `digests` row with markdown + usage + model.
 *
 * The processor never imports BullMQ types directly; it receives a
 * structural `BuildDigestJob` and the `WorkersLifecycle` in
 * `workers.module.ts` is the only caller, matching the pattern
 * `PollXProcessor` and `ExtractItemProcessor` already use.
 */

/** Minimal job shape — no BullMQ types in the public interface. */
export interface BuildDigestJob {
  data: unknown;
  attemptsMade: number;
}

/**
 * Zod schema validating the `build-digest` job payload at the worker
 * boundary. Window bounds are optional ISO-8601 strings; when absent
 * the processor falls back to `[now - digestIntervalMin, now]`.
 */
const BuildDigestJobSchema = z.object({
  userId: z.string().min(1),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
});

@Injectable()
export class BuildDigestProcessor {
  private readonly logger = new Logger(BuildDigestProcessor.name);

  constructor(
    private readonly users: UsersRepo,
    private readonly items: ItemsRepo,
    private readonly articles: ArticlesRepo,
    private readonly digests: DigestsRepo,
    private readonly graph: DigestGraph,
  ) {}

  async process(job: BuildDigestJob): Promise<void> {
    const parsed = BuildDigestJobSchema.safeParse(job.data);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.logger.warn(`skipping build-digest: invalid job payload — ${issues}`);
      return;
    }
    const { userId } = parsed.data;
    const start = Date.now();

    const user = await this.users.findById(userId);
    if (!user) {
      this.logger.warn(`skipping build-digest: user ${userId} not found`);
      return;
    }
    if (user.status !== 'active') {
      this.logger.warn(
        `skipping build-digest: user ${userId} is ${user.status}`,
      );
      return;
    }

    // Resolve the window. The caller can pin either bound (for the
    // `POST /digests/run-now` manual trigger and for tests); the
    // scheduler leaves both absent so we walk the user's cadence
    // backwards from `now`.
    const windowEnd = parsed.data.windowEnd
      ? new Date(parsed.data.windowEnd)
      : new Date();
    const intervalMs =
      (user.digestIntervalMin ?? DEFAULT_DIGEST_INTERVAL_MIN) * 60_000;
    const windowStart = parsed.data.windowStart
      ? new Date(parsed.data.windowStart)
      : new Date(windowEnd.getTime() - intervalMs);

    const enrichedItems = await this.items.findEnrichedInWindow(
      userId,
      windowStart,
      windowEnd,
    );
    if (enrichedItems.length === 0) {
      this.logger.log(
        `no enriched items for user ${userId} in window ${windowStart.toISOString()}..${windowEnd.toISOString()}, skipping`,
      );
      return;
    }

    const articleRecords = await this.articles.findByItemIds(
      enrichedItems.map((i) => i.id),
    );
    const articlesByItemId = groupArticlesByItemId(articleRecords);

    const graphItems: EnrichedItem[] = enrichedItems.map((item) =>
      toEnrichedItem(item, articlesByItemId.get(item.id) ?? []),
    );

    const result = await this.graph.run({
      userId,
      window: { start: windowStart, end: windowEnd },
      items: graphItems,
    });

    await this.digests.create({
      userId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      markdown: result.markdown,
      itemIds: result.itemIds,
      model: result.model,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
    });

    const durationMs = Date.now() - start;
    this.logger.log('build-digest complete', {
      userId,
      attempt: job.attemptsMade + 1,
      durationMs,
      itemsIncluded: graphItems.length,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      model: result.model,
    });
  }
}

function groupArticlesByItemId(
  articles: ArticleRecord[],
): Map<string, ArticleRecord[]> {
  const grouped = new Map<string, ArticleRecord[]>();
  for (const article of articles) {
    const bucket = grouped.get(article.itemId);
    if (bucket) {
      bucket.push(article);
    } else {
      grouped.set(article.itemId, [article]);
    }
  }
  return grouped;
}

function toEnrichedItem(
  item: ItemRecord,
  articles: ArticleRecord[],
): EnrichedItem {
  return {
    id: item.id,
    text: item.text,
    authorHandle: item.authorHandle,
    kind: item.kind,
    articles: articles.map((a) => {
      // Only emit optional fields when they're present so downstream
      // prompt templates don't render empty `undefined` noise.
      const out: EnrichedItem['articles'][number] = {
        url: a.url,
        content: a.content,
      };
      if (a.title !== undefined) out.title = a.title;
      if (a.siteName !== undefined) out.siteName = a.siteName;
      return out;
    }),
  };
}
