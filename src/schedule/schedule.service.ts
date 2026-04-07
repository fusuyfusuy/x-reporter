import { Injectable, Logger } from '@nestjs/common';

/**
 * `ScheduleService` registers and reconciles the per-user repeatable
 * BullMQ jobs (`user:{id}:poll`, `user:{id}:digest`) described in
 * `docs/jobs.md`.
 *
 * **This file is the milestone-#4 stub.** The real BullMQ-backed
 * implementation lands in milestone #5
 * (`feat(queue): BullMQ infra + ScheduleService`). The stub exists so
 * #4 can wire the call site (`PATCH /me` → `UsersService.updateCadence`
 * → `ScheduleService.upsertJobsForUser`) end-to-end without pulling
 * BullMQ in early. When #5 swaps the body of `upsertJobsForUser` for
 * the real impl, no consumer needs to change.
 *
 * The public surface is deliberately adapter-free: a single
 * `Promise<void>` method that takes a user id and nothing else. No
 * BullMQ types (`Queue`, `JobsOptions`, `Worker`), no Redis types
 * (`Redis`, `IORedisOptions`), no `repeatable` shape leaks here. That
 * is the hexagonal contract from `docs/swe-config.json`: the only place
 * BullMQ types live is `src/schedule/` itself, and only in #5.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  /**
   * Re-register the user's repeatable jobs at the user's current
   * cadence. Idempotent: calling it twice with the same user is a
   * no-op the second time (the real impl in #5 keys jobs by
   * `user:{id}:poll` / `user:{id}:digest` so re-adds collapse).
   *
   * Stub behavior: logs at info and resolves. The log line includes
   * `stub` so a tail of the application logs during #4 dev makes the
   * milestone boundary obvious — once #5 lands, the real impl removes
   * that marker.
   */
  async upsertJobsForUser(userId: string): Promise<void> {
    this.logger.log(
      `schedule.upsertJobsForUser(${userId}) — stub, real impl in #5`,
    );
  }
}
