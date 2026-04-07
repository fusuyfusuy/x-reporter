import { Global, Module } from '@nestjs/common';
import { UsersRepo } from './users.repo';

/**
 * `UsersRepoModule` provides {@link UsersRepo} as a process-wide
 * singleton so it is resolvable from any module without re-importing.
 *
 * Why this module exists (and is `@Global()`):
 *
 *   Historically `UsersRepo` was provided by `AuthModule.forRoot(env)`
 *   and re-provided by `UsersModule.forRoot(env)` so each feature module
 *   could wire it locally. That worked while the only consumers were
 *   `AuthService` (same module) and `UsersService` (same module).
 *
 *   Milestone #5 introduced a third consumer, `ScheduleService`, which
 *   lives in a separate module (`ScheduleModule`) that is itself
 *   `@Global()` and registered *before* `AuthModule` in
 *   `AppModule.forRoot()`. The old wiring left `UsersRepo` visible only
 *   inside `AuthModule` / `UsersModule`, so Nest's DI could not resolve
 *   it when constructing `ScheduleService`:
 *
 *       Nest can't resolve dependencies of the ScheduleService
 *       (POLL_X_QUEUE, BUILD_DIGEST_QUEUE, ?). Please make sure that
 *       the argument UsersRepo at index [2] is available in the
 *       ScheduleModule module.
 *
 *   Alternatives considered:
 *
 *     1. `forwardRef()` between `AuthModule` and `ScheduleModule`: that
 *        creates an explicit cycle between two feature modules just to
 *        expose a leaf adapter. Works, but it's strictly worse than
 *        extracting the leaf into its own module — every new consumer
 *        would have to learn about the cycle.
 *
 *     2. Pass cadence into `ScheduleService.upsertJobsForUser` as an
 *        argument: the handoff forbids this — the public surface is
 *        `(userId) => Promise<void>`, and the service MUST read the
 *        row itself so the caller does not have to couple to cadence
 *        defaults.
 *
 *     3. This module (chosen): lift `UsersRepo` to a dedicated global
 *        module, registered at the root before both `AuthModule` and
 *        `ScheduleModule`. The repo is a leaf adapter (depends only on
 *        `AppwriteService`, which is already global), so promoting it
 *        introduces no new coupling. Every consumer — `AuthService`,
 *        `UsersService`, `ScheduleService`, any future caller — injects
 *        `UsersRepo` the same way and Nest resolves it from this
 *        module's global scope.
 *
 * `UsersRepo` itself depends on `AppwriteService` (provided by the
 * `@Global() AppwriteModule.forRoot(env)` registered earlier in
 * `AppModule.forRoot()`), so there is nothing for this module to
 * import — Nest resolves the Appwrite dependency from the global
 * scope at construction time.
 */
@Global()
@Module({
  providers: [UsersRepo],
  exports: [UsersRepo],
})
export class UsersRepoModule {}
