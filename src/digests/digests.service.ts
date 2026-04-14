import { Inject, Injectable, Logger } from '@nestjs/common';
import { BUILD_DIGEST_QUEUE } from '../queue/queue.tokens';
import {
  DigestsRepo,
  type DigestRecord,
  type ListDigestsResult,
} from '../workers/digests.repo';

/**
 * Application service backing the `/digests` HTTP surface. Sits
 * between `DigestsController` (HTTP boundary, zod validation) and
 * `DigestsRepo` + the `build-digest` queue.
 *
 * Three responsibilities:
 *
 *   - `list(userId, limit, cursor)` — pagination for `GET /digests`.
 *     Projects each row into the documented list shape (with the
 *     `preview` trim applied) so the full markdown is never shipped
 *     over the list endpoint.
 *
 *   - `getById(userId, digestId)` — full-row read for
 *     `GET /digests/:id`. Scoped to the caller's userId so a malicious
 *     client can't probe other users' digests by guessing document
 *     ids. Returns `null` on both "not found" and "not yours"; the
 *     controller collapses both to a `404`.
 *
 *   - `enqueueRunNow(userId)` — pushes a one-shot job onto the
 *     `build-digest` queue for `POST /digests/run-now`. No window
 *     override: the processor falls back to `[now - digestInterval,
 *     now]`, matching the scheduler's cadence-driven runs.
 */

/**
 * Structural type for the slice of BullMQ's `Queue.add` we actually
 * call. Declared here (rather than importing the `bullmq` `Queue`
 * class) so BullMQ types stay confined to `src/queue/` and
 * `src/workers/` per the hexagonal rule in `docs/swe-config.json`.
 */
export interface BuildDigestQueueProducer {
  add(
    name: string,
    data: unknown,
    opts?: Record<string, unknown>,
  ): Promise<{ id?: string | undefined }>;
}

/** Wire shape for a single row in `GET /digests`. */
export interface DigestListItem {
  id: string;
  windowStart: string;
  windowEnd: string;
  model: string;
  createdAt: string;
  preview: string;
}

/** Wire shape for `GET /digests/:id`. Includes full markdown + usage. */
export type DigestDetail = DigestRecord;

/** Wire shape for `POST /digests/run-now`. */
export interface RunNowResult {
  jobId: string;
  queuedAt: string;
}

/** Paginated response for `GET /digests`. */
export interface DigestListResponse {
  items: DigestListItem[];
  nextCursor?: string;
}

/**
 * Maximum length of the `preview` field returned on list rows. The API
 * docs promise "~200 chars of markdown" — the constant lives here so
 * the controller's wire contract is driven by a single source of
 * truth, not a literal scattered through the service body.
 */
export const DIGEST_PREVIEW_LENGTH = 200;

/** Hard cap on `limit` for the list endpoint. */
export const DIGEST_LIST_MAX_LIMIT = 100;

/** Default `limit` when the caller doesn't specify one. */
export const DIGEST_LIST_DEFAULT_LIMIT = 20;

@Injectable()
export class DigestsService {
  private readonly logger = new Logger(DigestsService.name);

  constructor(
    private readonly digests: DigestsRepo,
    @Inject(BUILD_DIGEST_QUEUE)
    private readonly buildDigestQueue: BuildDigestQueueProducer,
  ) {}

  async list(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<DigestListResponse> {
    const raw: ListDigestsResult = await this.digests.listByUser({
      userId,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const items = raw.items.map(toListItem);
    if (raw.nextCursor) {
      return { items, nextCursor: raw.nextCursor };
    }
    return { items };
  }

  async getById(userId: string, digestId: string): Promise<DigestDetail | null> {
    return this.digests.findByIdAndUser(digestId, userId);
  }

  /**
   * Enqueue a one-shot `build-digest` job for the caller. Retry /
   * removal policy matches the scheduler-driven run (see
   * `docs/jobs.md`): 3 attempts, exponential backoff (60s base, 10m
   * cap), `removeOnComplete` after a day, `removeOnFail` after a week.
   *
   * Returns the BullMQ-assigned `jobId` so the caller can correlate
   * the eventual digest row with the 202 response. When BullMQ
   * somehow doesn't return an id (shouldn't happen in practice, but
   * the `Queue.add` type admits `undefined`), we fall back to an
   * empty string rather than throw — a missing id only degrades
   * observability, it doesn't invalidate the enqueue.
   */
  async enqueueRunNow(userId: string): Promise<RunNowResult> {
    const job = await this.buildDigestQueue.add(
      'build-digest',
      { userId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 604_800 },
      },
    );
    const queuedAt = new Date().toISOString();
    this.logger.log('build-digest run-now enqueued', {
      userId,
      jobId: job.id,
      queuedAt,
    });
    return { jobId: job.id ?? '', queuedAt };
  }
}

function toListItem(record: DigestRecord): DigestListItem {
  return {
    id: record.id,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    model: record.model,
    createdAt: record.createdAt,
    preview: truncatePreview(record.markdown),
  };
}

function truncatePreview(markdown: string): string {
  if (markdown.length <= DIGEST_PREVIEW_LENGTH) return markdown;
  return markdown.slice(0, DIGEST_PREVIEW_LENGTH);
}
