import { Global, Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';

/**
 * `ScheduleModule` provides {@link ScheduleService}, the seam between
 * the cadence-update side effect (`PATCH /me`,
 * `/auth/x/callback`, …) and the BullMQ repeatable-job machinery.
 *
 * **Why `@Global()`?** The real implementation in milestone #5
 * (`feat(queue): BullMQ infra + ScheduleService`) introduces a
 * construction-time dependency on Redis (the BullMQ `connection`).
 * Marking the module global means the eventual swap is purely an
 * implementation change inside this directory: every consumer
 * (`UsersModule`, the future `AuthModule` post-callback wiring,
 * worker startup) just injects `ScheduleService` and never imports
 * `ScheduleModule` directly. That keeps the milestone-#5 PR diff
 * laser-focused on `src/schedule/` instead of cascading through the
 * dependency graph.
 *
 * The stub deliberately exposes nothing else — no queue tokens, no
 * connection providers, no BullMQ adapters — so the `Global` decision
 * is cheap to revisit if #5 finds it preferable to scope the module.
 */
@Global()
@Module({
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
