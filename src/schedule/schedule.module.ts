import { Global, Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ScheduleService } from './schedule.service';

/**
 * `ScheduleModule` exposes {@link ScheduleService}, the seam between
 * the cadence-update side effect (`PATCH /me`, `/auth/x/callback`,
 * `AuthService.failAuth`, ...) and the BullMQ repeatable-job
 * machinery provided by {@link QueueModule}.
 *
 * Why `@Global()`: `ScheduleService` is injected by `AuthService` and
 * `UsersService`. Making the module global means consumers do not
 * have to re-import `ScheduleModule` everywhere — they just list
 * `ScheduleService` in their constructor. This also keeps the
 * BullMQ/ioredis containment rule intact: no feature module outside
 * `src/queue/` and `src/schedule/` imports a BullMQ or ioredis
 * symbol, they all go through `ScheduleService`.
 *
 * `QueueModule` is itself `@Global()` (see `queue.module.ts`) and is
 * registered once at the root in `AppModule.forRoot()`. Importing it
 * here is a no-op at the DI level — Nest dedupes global modules — but
 * the explicit import makes it obvious that `ScheduleService` depends
 * on the queue tokens (and on `UsersRepo`, resolved separately).
 *
 * `UsersRepo` is not re-registered here: it is provided by the
 * `@Global()` `UsersRepoModule` (registered at the root in
 * `AppModule.forRoot()`), so `ScheduleService` resolves it from the
 * global scope at construction time. The split between `UsersRepoModule`
 * and `AuthModule` exists specifically to break the
 * `AuthService` ↔ `ScheduleService` ↔ `UsersRepo` cycle that an
 * `AuthModule`-owned `UsersRepo` would otherwise create.
 */
@Global()
@Module({
  imports: [QueueModule],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
