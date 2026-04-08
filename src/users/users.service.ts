import { Injectable, Logger } from '@nestjs/common';
import { ScheduleService } from '../schedule/schedule.service';
import {
  DEFAULT_DIGEST_INTERVAL_MIN,
  DEFAULT_POLL_INTERVAL_MIN,
} from './cadence.constants';
import { type UpdateCadenceInput, type UserRecord, UsersRepo } from './users.repo';

/**
 * Re-exported here so existing consumers that import
 * `DEFAULT_POLL_INTERVAL_MIN` / `DEFAULT_DIGEST_INTERVAL_MIN` from
 * `users.service.ts` continue to compile unchanged. The values live
 * in `./cadence.constants.ts` to break the import cycle with
 * `schedule.service.ts` (see that file's header comment).
 */
export { DEFAULT_DIGEST_INTERVAL_MIN, DEFAULT_POLL_INTERVAL_MIN };

/**
 * Application service for the `/me` surface. Sits between
 * `UsersController` (HTTP boundary, zod validation) and `UsersRepo` +
 * `ScheduleService` (data + scheduling adapters).
 *
 * Two responsibilities:
 *
 *   1. **Read profile (`getProfile`)** — load the row, project it into
 *      the documented `/me` shape, and substitute the documented
 *      defaults (60 / 1440) for any cadence field that has never been
 *      patched. Clients should never see `undefined` here; the docs
 *      promise numbers.
 *
 *   2. **Patch cadence (`updateCadence`)** — the entire reason
 *      `UsersService` exists. The HTTP layer can't combine
 *      "persist + register jobs" because the controller MUST stay free
 *      of `ScheduleService` knowledge so the adapter swap in #5 only
 *      touches the schedule module. The orchestration also has a
 *      meaningful failure shape:
 *
 *        - Repo throws → schedule is NOT called. The contract is
 *          "register jobs against the new cadence", not "register
 *          jobs against whatever cadence happens to be in flight". A
 *          half-applied state would re-poll on the old interval and
 *          confuse anyone debugging the failure.
 *
 *        - Schedule throws → wrap the error in `ScheduleSyncError`
 *          before rethrowing. The controller maps that to `502`
 *          (upstream dependency failure), the same shape
 *          `AuthController` already uses for X / Appwrite outages.
 *          The repo state is committed at this point — that's
 *          deliberate. The next successful PATCH (whether from this
 *          user or from #5's eventual reconciliation worker) will
 *          re-sync.
 *
 * Why error wrapping instead of letting the raw error propagate: the
 * controller needs a stable signal to distinguish "the user gave us
 * bad input" (zod 400) from "the database broke" (500) from "the
 * scheduler dependency broke" (502). Without the wrapper the
 * controller would have to `instanceof` against BullMQ / Redis errors
 * directly, leaking the adapter into the HTTP layer.
 */

/**
 * Wire shape returned to clients by `GET /me` and `PATCH /me`. Differs
 * from `UserRecord` in two ways:
 *
 *   - Cadence fields are required (defaults applied).
 *   - No internal Appwrite metadata (`$createdAt`, etc.) leaks here —
 *     `UserRecord` already strips that, but we re-name on the wire so
 *     a future repo refactor can't accidentally widen the response.
 */
export interface MeProfile {
  id: string;
  xUserId: string;
  handle: string;
  pollIntervalMin: number;
  digestIntervalMin: number;
  status: UserRecord['status'];
  createdAt: string;
}

/**
 * Thrown when a request arrives carrying a valid session cookie but
 * the underlying `users` row no longer exists. Possible causes: a
 * deleted account, a manual Appwrite cleanup, or a stale cookie
 * issued before the row was reset. The controller maps this to `404`.
 *
 * The exception message is intentionally generic and free of identifiers
 * so global exception filters / telemetry pipelines that persist
 * `err.message` cannot accidentally leak a stable user id into shared
 * logs. The owning `userId` is still available on the instance via the
 * `userId` property for code paths that legitimately need it (tests,
 * structured-logging adapters that pin it under a redactable field).
 */
export class UserNotFoundError extends Error {
  readonly userId: string;
  constructor(userId: string) {
    super('user not found');
    this.name = 'UserNotFoundError';
    this.userId = userId;
  }
}

/**
 * Thrown when {@link UsersService.updateCadence} commits the repo
 * write but the post-write `ScheduleService.upsertJobsForUser` call
 * fails. The controller maps this to `502` so monitoring can tell
 * "scheduler outage" apart from "appwrite outage" (which surfaces as
 * the underlying repo error → `500`) and from "user input invalid"
 * (which the zod schema rejects with `400` long before this service
 * is reached).
 *
 * The exception message is generic for the same reason as
 * {@link UserNotFoundError}: the underlying adapter error and userId
 * are kept on the instance (`cause`, `userId`) and emitted via
 * structured logging from the throw site, so they're still available
 * to operators without being interpolated into a string that may end
 * up in shared log storage or HTTP error bodies.
 */
export class ScheduleSyncError extends Error {
  readonly userId: string;
  // `cause` is the standard ES2022 field; declaring it explicitly so
  // TypeScript infers it on instances and the controller can pass it
  // through to logger context if needed.
  override readonly cause?: unknown;
  constructor(userId: string, cause?: unknown) {
    super('schedule sync failed');
    this.name = 'ScheduleSyncError';
    this.userId = userId;
    this.cause = cause;
  }
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly users: UsersRepo,
    private readonly schedule: ScheduleService,
  ) {}

  /** Load the user and project into the `/me` shape. */
  async getProfile(userId: string): Promise<MeProfile> {
    const record = await this.users.findById(userId);
    if (!record) throw new UserNotFoundError(userId);
    return toMeProfile(record);
  }

  /**
   * Apply a cadence patch and re-register the user's repeatable jobs.
   * See class doc for the failure-mode contract.
   *
   * No pre-read: `UsersRepo.updateCadence` already returns `null` for
   * the missing-row case, so an extra `findById` round-trip would only
   * pay for itself if it could prevent the race — but it cannot, the
   * row can still vanish between the read and the write. Relying on
   * the write's own null signal saves an Appwrite call on every PATCH
   * without changing the failure semantics.
   */
  async updateCadence(userId: string, patch: UpdateCadenceInput): Promise<MeProfile> {
    // 1. Persist the patch. Any failure here propagates as-is — the
    //    controller maps an unknown throw to 500 and we deliberately
    //    do NOT trigger the schedule sync, because no new cadence
    //    actually landed.
    //
    //    `updateCadence` returns `null` for the deleted-user race —
    //    map it to `UserNotFoundError` so the controller answers
    //    `404 not_found` instead of falling through to a 500.
    const updated = await this.users.updateCadence(userId, patch);
    if (!updated) throw new UserNotFoundError(userId);

    // 2. Register the repeatable jobs against the new cadence. A
    //    failure here is wrapped in ScheduleSyncError so the
    //    controller can map to 502 without leaking the adapter type.
    //    The repo write has already committed at this point — that's
    //    by design; the next successful PATCH reconciles.
    try {
      await this.schedule.upsertJobsForUser(userId);
    } catch (err) {
      // Structured log: `userId` is a separate field (so a future
      // pino redact rule can scrub it from shared log storage if
      // policy demands), and `err` carries the full stack + adapter
      // context for production debugging. Crucially, neither lands
      // in the message string of the thrown ScheduleSyncError — that
      // string surfaces in the HTTP body via the controller, so
      // keeping it generic prevents adapter internals from reaching
      // clients.
      this.logger.warn(
        { err, userId },
        'schedule.upsertJobsForUser failed',
      );
      throw new ScheduleSyncError(userId, err);
    }

    return toMeProfile(updated);
  }
}

/**
 * Convert a `UserRecord` into the `/me` wire shape, applying the
 * documented defaults to any cadence field the row hasn't patched yet.
 * Pure function — no side effects, no logger — so it's trivially
 * reusable from both `getProfile` and `updateCadence`.
 */
function toMeProfile(record: UserRecord): MeProfile {
  return {
    id: record.id,
    xUserId: record.xUserId,
    handle: record.handle,
    pollIntervalMin: record.pollIntervalMin ?? DEFAULT_POLL_INTERVAL_MIN,
    digestIntervalMin: record.digestIntervalMin ?? DEFAULT_DIGEST_INTERVAL_MIN,
    status: record.status,
    createdAt: record.createdAt,
  };
}
