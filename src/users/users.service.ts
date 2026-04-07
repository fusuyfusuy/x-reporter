import { Injectable, Logger } from '@nestjs/common';
import { ScheduleService } from '../schedule/schedule.service';
import { type UpdateCadenceInput, type UserRecord, UsersRepo } from './users.repo';

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
 * Documented defaults for the cadence fields. Mirrors `data-model.md`
 * (the schema marks both fields optional so the app-layer default
 * applies to never-patched users) and `api.md` (the example response
 * uses 60 / 1440). Centralised here so any future change has exactly
 * one source of truth.
 */
export const DEFAULT_POLL_INTERVAL_MIN = 60;
export const DEFAULT_DIGEST_INTERVAL_MIN = 1440;

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
 */
export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`user not found: ${userId}`);
    this.name = 'UserNotFoundError';
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
 */
export class ScheduleSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleSyncError';
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
   */
  async updateCadence(userId: string, patch: UpdateCadenceInput): Promise<MeProfile> {
    // Cheap pre-check so we don't burn an Appwrite write on a user
    // whose row vanished between session and patch. Without this the
    // repo's updateDocument would surface a 404 that's harder for the
    // controller to map back to the typed error.
    const existing = await this.users.findById(userId);
    if (!existing) throw new UserNotFoundError(userId);

    // 1. Persist the patch. Any failure here propagates as-is — the
    //    controller maps an unknown throw to 500 and we deliberately
    //    do NOT trigger the schedule sync, because no new cadence
    //    actually landed.
    const updated = await this.users.updateCadence(userId, patch);

    // 2. Register the repeatable jobs against the new cadence. A
    //    failure here is wrapped in ScheduleSyncError so the
    //    controller can map to 502 without leaking the adapter type.
    //    The repo write has already committed at this point — that's
    //    by design; the next successful PATCH reconciles.
    try {
      await this.schedule.upsertJobsForUser(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `schedule.upsertJobsForUser failed for ${userId}: ${message}`,
      );
      throw new ScheduleSyncError(
        `schedule sync failed for user ${userId}: ${message}`,
      );
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
