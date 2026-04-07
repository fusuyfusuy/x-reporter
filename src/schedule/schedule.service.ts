import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { BUILD_DIGEST_QUEUE, POLL_X_QUEUE } from '../queue/queue.tokens';
// Constants live in `cadence.constants.ts`, not `users.service.ts`, to
// break the import cycle: `UsersService` injects `ScheduleService`, so
// `schedule.service.ts` cannot pull a value from `users.service.ts` at
// module evaluation time. The values remain re-exported from
// `users.service.ts` for existing consumers.
import {
  DEFAULT_DIGEST_INTERVAL_MIN,
  DEFAULT_POLL_INTERVAL_MIN,
} from '../users/cadence.constants';
import { UsersRepo } from '../users/users.repo';

/**
 * `ScheduleService` is the seam between the application layer (cadence
 * updates from `PATCH /me`, the `/auth/x/callback` sign-in, the future
 * user-delete endpoint) and the BullMQ repeatable-job machinery.
 *
 * Its public surface is deliberately **adapter-free**: two `Promise<void>`
 * methods that take nothing but a user id. BullMQ types (`Queue`,
 * `Job`, `RepeatOptions`, the BullMQ 5.x `JobScheduler` types) never
 * appear on the method signatures — they stay sealed inside this file
 * and `src/queue/`. That is the hexagonal containment rule from
 * `docs/swe-config.json`: BullMQ + ioredis types live only in
 * `src/queue/` and `src/schedule/`.
 *
 * ---
 *
 * ## Repeatable job contract (per `docs/jobs.md`)
 *
 * Every user has two repeatable BullMQ jobs:
 *
 * | scheduler id          | queue         | interval                          |
 * |-----------------------|---------------|-----------------------------------|
 * | `user:{id}:poll`      | `poll-x`      | `user.pollIntervalMin` minutes    |
 * | `user:{id}:digest`    | `build-digest`| `user.digestIntervalMin` minutes  |
 *
 * The interval falls back to the documented defaults
 * (`DEFAULT_POLL_INTERVAL_MIN` / `DEFAULT_DIGEST_INTERVAL_MIN` imported
 * from `UsersService`) when the user row has no cadence set. These
 * constants are imported, NEVER hardcoded, so any future change lives
 * in exactly one place.
 *
 * ## BullMQ 5.x job scheduler API
 *
 * BullMQ 5 replaced the older `addRepeatable` / `removeRepeatableByKey`
 * pair with the Job Scheduler API:
 *
 *   - `queue.upsertJobScheduler(id, repeatOpts, template)` — creates a
 *     new scheduler OR updates an existing one in place. This is
 *     exactly the "replace on cadence change" semantic the milestone
 *     needs: re-upserting with the same id but a different `every`
 *     value leaves one entry behind, not two.
 *   - `queue.removeJobScheduler(id)` — removes the scheduler by id;
 *     returns `false` (no throw) when the id does not exist, which is
 *     what makes `removeJobsForUser` idempotent.
 *
 * The older `removeRepeatableByKey` path is deprecated in 5.x and
 * slated for removal in 6 — using the scheduler API now avoids a
 * migration later.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    @Inject(POLL_X_QUEUE) private readonly pollXQueue: Queue,
    // NOTE: `extract-item` is the downstream queue populated by
    // `PollXProcessor` (milestone #7), not by any repeatable job. The
    // token is intentionally NOT injected here — that would invite a
    // future refactor to schedule per-user extract jobs, which is
    // explicitly not the contract. A consumer that later needs to
    // enqueue extract-item jobs should go through the queue module
    // directly, not through ScheduleService.
    @Inject(BUILD_DIGEST_QUEUE) private readonly buildDigestQueue: Queue,
    private readonly users: UsersRepo,
  ) {}

  /**
   * Re-register the user's repeatable jobs at the user's current
   * cadence.
   *
   * Contract:
   *
   *   1. Load the user row via `UsersRepo.findById`. If the row is
   *      missing, log a `warn` and return. A routine cadence sync
   *      should not crash on a deleted-user race — the workers would
   *      fail loudly for the same user anyway.
   *
   *   2. Resolve `pollIntervalMin` and `digestIntervalMin` from the
   *      row, falling back to the documented defaults imported from
   *      `UsersService`. Convert minutes → ms for BullMQ.
   *
   *   3. Upsert both schedulers. BullMQ's job scheduler semantics make
   *      this idempotent by default: re-upserting with the same
   *      scheduler id overwrites the existing entry, and the scheduler
   *      key is `user:{id}:poll` / `user:{id}:digest` regardless of
   *      cadence, so a cadence change replaces rather than duplicates.
   *
   *   4. Pass `{ userId }` in the job template `data` so workers
   *      (#7 / #11) receive it in `job.data` without having to parse
   *      the scheduler id.
   *
   * Never returns a BullMQ type — the return is `Promise<void>` so the
   * caller cannot accidentally depend on scheduler internals.
   */
  async upsertJobsForUser(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      // Deleted-user race (the user row was removed between the caller
      // learning the id and this method reading it). Not an error — a
      // routine cadence sync should not fail because the row is gone.
      // Workers would fail fast on the same missing row anyway.
      this.logger.warn(
        `schedule.upsertJobsForUser(${userId}): user not found, skipping`,
      );
      return;
    }

    const pollIntervalMin = user.pollIntervalMin ?? DEFAULT_POLL_INTERVAL_MIN;
    const digestIntervalMin =
      user.digestIntervalMin ?? DEFAULT_DIGEST_INTERVAL_MIN;

    const pollEveryMs = pollIntervalMin * 60_000;
    const digestEveryMs = digestIntervalMin * 60_000;

    const pollJobSchedulerId = pollSchedulerId(userId);
    const digestJobSchedulerId = digestSchedulerId(userId);

    // Upsert the poll-x scheduler. The `name` in the template is the
    // BullMQ job name that workers dispatch on (e.g. `poll-x`). Keeping
    // it identical to the queue name keeps observability dashboards
    // coherent: one-job-name-per-queue, no split reporting.
    await this.pollXQueue.upsertJobScheduler(
      pollJobSchedulerId,
      { every: pollEveryMs },
      {
        name: 'poll-x',
        data: { userId },
      },
    );

    await this.buildDigestQueue.upsertJobScheduler(
      digestJobSchedulerId,
      { every: digestEveryMs },
      {
        name: 'build-digest',
        data: { userId },
      },
    );
  }

  /**
   * Remove both repeatable jobs for the user.
   *
   * Idempotent: removing a scheduler that does not exist is a no-op,
   * not an error. BullMQ's `removeJobScheduler` returns `false` for
   * missing ids without throwing, which is exactly the shape this
   * contract needs.
   *
   * Called by:
   *   - `AuthService.failAuth(userId)` after a successful
   *     `setStatus('auth_expired')` transition, so a stuck user stops
   *     being polled.
   *   - (reserved) a future user-delete endpoint.
   *
   * Does NOT call `UsersRepo.findById`. The only inputs required are
   * the scheduler ids (both derived from the `userId`), and a deleted
   * user is the primary use case for removal — pre-reading would mean
   * we could not remove schedulers for a user whose row is gone.
   */
  async removeJobsForUser(userId: string): Promise<void> {
    // Run both removals regardless of the first result. We want both
    // schedulers gone even if one was already removed manually or by a
    // previous failAuth call.
    await this.pollXQueue.removeJobScheduler(pollSchedulerId(userId));
    await this.buildDigestQueue.removeJobScheduler(digestSchedulerId(userId));
  }
}

/**
 * Scheduler id format for the poll-x repeatable. Factored out so both
 * upsert and remove use the same string shape and a future rename is
 * mechanical.
 */
function pollSchedulerId(userId: string): string {
  return `user:${userId}:poll`;
}

/** Scheduler id format for the build-digest repeatable. */
function digestSchedulerId(userId: string): string {
  return `user:${userId}:digest`;
}
