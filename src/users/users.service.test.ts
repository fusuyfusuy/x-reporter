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
    // The wrapper preserves the underlying message for log surface.
    expect((err as Error).message).toContain('schedule sync failed');
    // The repo write *did* commit — only the post-write side effect
    // failed. That's expected; next successful PATCH reconciles.
    expect(scheduleState.calls).toEqual(['u_abc']);
  });

  it('throws UserNotFoundError when the user row vanishes between session and patch', async () => {
    const { repo } = makeFakeRepo([]);
    const { schedule } = makeFakeSchedule();
    const service = new UsersService(repo, schedule);
    await expect(
      service.updateCadence('u_missing', { pollIntervalMin: 10 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it('throws UserNotFoundError when the row is deleted between pre-read and updateCadence (race window)', async () => {
    // The pre-read in `updateCadence` is a cheap optimization, not a
    // synchronization primitive — there is a real time window where a
    // concurrent admin delete (or another tab calling DELETE /me in
    // #11) can land between `findById` and `updateCadence`. The repo's
    // updateDocument would surface that as a raw Appwrite 404, and
    // without explicit handling the controller would map it to a 500
    // instead of the documented `404 not_found`. We simulate the race
    // by deleting the row from the fake repo state mid-flight via a
    // findById hook that vanishes the record after returning it once.
    const { repo, state: repoState } = makeFakeRepo([baseRecord]);
    const { schedule, state: scheduleState } = makeFakeSchedule();

    // Wrap the existing fake's findById so the row disappears the
    // moment the service is done reading it. The next call to
    // updateCadence then sees an empty Map and returns null (the
    // documented "row gone" signal), which the service must map to
    // UserNotFoundError.
    const originalFindById = repo.findById.bind(repo);
    repo.findById = async (id: string) => {
      const result = await originalFindById(id);
      repoState.records.delete(id);
      return result;
    };

    const service = new UsersService(repo, schedule);
    await expect(
      service.updateCadence('u_abc', { pollIntervalMin: 30 }),
    ).rejects.toBeInstanceOf(UserNotFoundError);

    // The schedule sync must NOT have run — there is no row to
    // schedule jobs against, and #5's BullMQ implementation would
    // otherwise leak a job for a deleted user.
    expect(scheduleState.calls).toEqual([]);
  });
});
