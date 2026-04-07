import { describe, expect, it } from 'bun:test';
import type { ScheduleService } from '../schedule/schedule.service';
import type { UpdateCadenceInput, UserRecord, UsersRepo } from './users.repo';
import { ScheduleSyncError, UsersService, UserNotFoundError } from './users.service';

/**
 * Service-level orchestration tests for the cadence patch flow.
 *
 * The boundary contract `UsersService` enforces (per the spec):
 *
 *   1. `getProfile(userId)` returns the documented `/me` shape, falling
 *      back to documented defaults (60 / 1440) when the row has no
 *      cadence values yet. Throws `UserNotFoundError` if the row is
 *      gone (e.g. session cookie outlives a deletion).
 *
 *   2. `updateCadence(userId, patch)`:
 *      a. Calls `repo.updateCadence` first.
 *      b. If the repo throws → schedule sync is NOT called and the
 *         error bubbles unchanged. We must not register jobs against
 *         a row whose write failed.
 *      c. If the repo succeeds → calls
 *         `schedule.upsertJobsForUser(userId)` exactly once.
 *      d. If schedule throws → wraps the error in `ScheduleSyncError`
 *         (so the controller maps it to 502, not 500). The repo state
 *         is already committed at this point — that's expected; the
 *         next successful PATCH will reconcile.
 *      e. Returns the post-update profile shape (defaults applied).
 */

interface FakeRepoState {
  records: Map<string, UserRecord>;
  updateCalls: Array<{ id: string; patch: UpdateCadenceInput }>;
  updateBehavior: 'ok' | 'throw';
  findBehavior: 'ok' | 'throw';
}

function makeFakeRepo(initial: UserRecord[] = []): {
  repo: UsersRepo;
  state: FakeRepoState;
} {
  const state: FakeRepoState = {
    records: new Map(initial.map((r) => [r.id, { ...r }])),
    updateCalls: [],
    updateBehavior: 'ok',
    findBehavior: 'ok',
  };
  const repo: Pick<UsersRepo, 'findById' | 'updateCadence'> = {
    async findById(id: string) {
      if (state.findBehavior === 'throw') throw new Error('repo down');
      return state.records.get(id) ?? null;
    },
    async updateCadence(id: string, patch: UpdateCadenceInput) {
      state.updateCalls.push({ id, patch });
      if (state.updateBehavior === 'throw') {
        throw new Error('repo write failed');
      }
      const existing = state.records.get(id);
      if (!existing) {
        // Mirrors the real repo's contract: "row gone" returns `null`,
        // not throws. Lets the service map the concurrent-delete race
        // to UserNotFoundError → 404 instead of leaking a 500.
        return null;
      }
      const next: UserRecord = { ...existing, ...patch };
      state.records.set(id, next);
      return next;
    },
  };
  return { repo: repo as UsersRepo, state };
}

interface FakeScheduleState {
  calls: string[];
  behavior: 'ok' | 'throw';
}

function makeFakeSchedule(): { schedule: ScheduleService; state: FakeScheduleState } {
  const state: FakeScheduleState = { calls: [], behavior: 'ok' };
  const schedule: Pick<ScheduleService, 'upsertJobsForUser'> = {
    async upsertJobsForUser(userId: string) {
      state.calls.push(userId);
      if (state.behavior === 'throw') {
        throw new Error('schedule sync failed');
      }
    },
  };
  return { schedule: schedule as ScheduleService, state };
}

const baseRecord: UserRecord = {
  id: 'u_abc',
  xUserId: '12345',
  handle: 'fusuyfusuy',
  status: 'active',
  createdAt: '2026-04-06T12:00:00Z',
};

describe('UsersService.getProfile', () => {
  it('returns the documented /me shape with defaults when cadence is unset', async () => {
    const { repo } = makeFakeRepo([baseRecord]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    const profile = await service.getProfile('u_abc');
    expect(profile).toEqual({
      id: 'u_abc',
      xUserId: '12345',
      handle: 'fusuyfusuy',
      pollIntervalMin: 60,
      digestIntervalMin: 1440,
      status: 'active',
      createdAt: '2026-04-06T12:00:00Z',
    });
  });

  it('returns the persisted cadence when set', async () => {
    const { repo } = makeFakeRepo([
      { ...baseRecord, pollIntervalMin: 30, digestIntervalMin: 720 },
    ]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    const profile = await service.getProfile('u_abc');
    expect(profile.pollIntervalMin).toBe(30);
    expect(profile.digestIntervalMin).toBe(720);
  });

  it('throws UserNotFoundError when the user row is gone', async () => {
    const { repo } = makeFakeRepo([]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    await expect(service.getProfile('u_missing')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });
});

describe('UsersService.updateCadence', () => {
  it('persists the patch and triggers schedule sync exactly once', async () => {
    const { repo, state: repoState } = makeFakeRepo([baseRecord]);
    const { schedule, state: scheduleState } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);

    const profile = await service.updateCadence('u_abc', {
      pollIntervalMin: 30,
      digestIntervalMin: 720,
    });

    expect(repoState.updateCalls).toEqual([
      { id: 'u_abc', patch: { pollIntervalMin: 30, digestIntervalMin: 720 } },
    ]);
    expect(scheduleState.calls).toEqual(['u_abc']);
    expect(profile.pollIntervalMin).toBe(30);
    expect(profile.digestIntervalMin).toBe(720);
  });

  it('returns the documented defaults for any field absent from the post-update record', async () => {
    // The user only patched poll. The response must still report
    // digest as the default 1440, never `undefined`.
    const { repo } = makeFakeRepo([baseRecord]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    const profile = await service.updateCadence('u_abc', { pollIntervalMin: 10 });
    expect(profile.pollIntervalMin).toBe(10);
    expect(profile.digestIntervalMin).toBe(1440);
  });

  it('does NOT call schedule sync when the repo write fails', async () => {
    const { repo, state: repoState } = makeFakeRepo([baseRecord]);
    repoState.updateBehavior = 'throw';
    const { schedule, state: scheduleState } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);

    await expect(
      service.updateCadence('u_abc', { pollIntervalMin: 30 }),
    ).rejects.toThrow('repo write failed');

    expect(scheduleState.calls).toEqual([]);
  });

  it('wraps a schedule failure in ScheduleSyncError so the controller can map to 502', async () => {
    const { repo } = makeFakeRepo([baseRecord]);
    const { schedule, state: scheduleState } = makeFakeSchedule();
    scheduleState.behavior = 'throw';
    const service = new UsersService(repo, schedule);

    const err = await service
      .updateCadence('u_abc', { pollIntervalMin: 30 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ScheduleSyncError);
    // The wrapper preserves the underlying error on `cause` for
    // structured logging without leaking it into `.message` (which
    // would otherwise reach the HTTP body via the controller's
    // exception filter and shared log storage).
    expect((err as ScheduleSyncError).cause).toBeInstanceOf(Error);
    expect(((err as ScheduleSyncError).cause as Error).message).toBe(
      'schedule sync failed',
    );
    expect((err as Error).message).toBe('schedule sync failed');
    // The repo write *did* commit — only the post-write side effect
    // failed. That's expected; next successful PATCH reconciles.
    expect(scheduleState.calls).toEqual(['u_abc']);
  });

  it('throws UserNotFoundError when the row is missing on PATCH (deleted-user / race window)', async () => {
    // No pre-read: the service relies on `UsersRepo.updateCadence`
    // returning `null` to detect the deleted-user case, which covers
    // both "row was already gone before the request" and "row
    // disappeared between any external check and this write" — the
    // fake repo collapses both into the same code path. We assert
    // the typed error AND that schedule sync did not run, since the
    // BullMQ implementation in #5 must never leak a repeatable job
    // for a deleted user.
    const { repo, state: repoState } = makeFakeRepo([]);
    const { schedule, state: scheduleState } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    await expect(
      service.updateCadence('u_missing', { pollIntervalMin: 10 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
    // The single-round-trip contract: exactly one updateCadence call,
    // no preceding findById. This locks the optimization in place so
    // a future "defensive" pre-read can't sneak back in and double
    // the Appwrite traffic on every PATCH.
    expect(repoState.updateCalls).toHaveLength(1);
    expect(scheduleState.calls).toEqual([]);
  });

  it('does not pre-read before updateCadence on the happy path either', async () => {
    // Locks the contract that the service makes exactly one repo
    // call (the write) on success. The redundant findById was
    // removed so PATCH /me costs one Appwrite round-trip, not two.
    const { repo, state: repoState } = makeFakeRepo([baseRecord]);
    let findByIdCalls = 0;
    const originalFindById = repo.findById.bind(repo);
    repo.findById = async (id: string) => {
      findByIdCalls++;
      return originalFindById(id);
    };
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    await service.updateCadence('u_abc', { pollIntervalMin: 30 });
    expect(findByIdCalls).toBe(0);
    expect(repoState.updateCalls).toHaveLength(1);
  });

  it('does not embed userId or adapter details in error messages or HTTP-bound strings', async () => {
    // PII / leak guard: `UserNotFoundError` and `ScheduleSyncError`
    // both surface their `.message` to the controller, which then
    // serializes it into the response body or hands it to the global
    // exception filter. Embedding `userId` or the raw adapter error
    // would leak a stable identifier and internal scheduler details
    // into shared log storage. The data is still available on the
    // instance via `userId` / `cause` for structured logging.
    const { repo } = makeFakeRepo([]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    let notFoundErr: unknown;
    try {
      await service.updateCadence('u_secret_id_123', { pollIntervalMin: 10 });
    } catch (e) {
      notFoundErr = e;
    }
    expect(notFoundErr).toBeInstanceOf(UserNotFoundError);
    expect((notFoundErr as Error).message).toBe('user not found');
    expect((notFoundErr as Error).message).not.toContain('u_secret_id_123');
    // The instance still carries the userId for tests / structured logs.
    expect((notFoundErr as UserNotFoundError).userId).toBe('u_secret_id_123');

    // Same guarantee for the schedule failure path. Use the seeded
    // baseRecord id ('u_abc') so the repo write succeeds and the
    // service actually reaches the schedule sync — that's the only
    // code path where ScheduleSyncError gets thrown. The leak guard
    // is then checked by ensuring 'u_abc' does NOT appear in the
    // exception message string.
    const { repo: repo2 } = makeFakeRepo([baseRecord]);
    const { schedule: schedule2, state: scheduleState2 } = makeFakeSchedule();
    scheduleState2.behavior = 'throw';
    const service2 = new UsersService(repo2, schedule2);
    let scheduleErr: unknown;
    try {
      await service2.updateCadence('u_abc', { pollIntervalMin: 10 });
    } catch (e) {
      scheduleErr = e;
    }
    expect(scheduleErr).toBeInstanceOf(ScheduleSyncError);
    expect((scheduleErr as Error).message).toBe('schedule sync failed');
    expect((scheduleErr as Error).message).not.toContain('u_abc');
    // Adapter cause is preserved on the instance for logging.
    expect((scheduleErr as ScheduleSyncError).userId).toBe('u_abc');
    expect((scheduleErr as ScheduleSyncError).cause).toBeInstanceOf(Error);
  });
});
