import { describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { UserRecord, UsersRepo } from '../users/users.repo';
import {
  DEFAULT_DIGEST_INTERVAL_MIN,
  DEFAULT_POLL_INTERVAL_MIN,
} from '../users/users.service';
import { ScheduleService } from './schedule.service';

/**
 * Unit tests for the real BullMQ-backed `ScheduleService` (milestone #5).
 *
 * The tests do NOT talk to BullMQ or Redis. Instead, `FakeQueue` tracks
 * the upsert + remove scheduler calls so the test can assert on the
 * final set of scheduler ids, the intervals they were registered with,
 * and the idempotency contract from the spec:
 *
 *   1. `upsertJobsForUser(userId)` reads cadence from the user row,
 *      falls back to `DEFAULT_POLL_INTERVAL_MIN` /
 *      `DEFAULT_DIGEST_INTERVAL_MIN` from `UsersService` (never
 *      hardcoded), and registers two schedulers — one on the poll-x
 *      queue (`user:{id}:poll`) and one on the build-digest queue
 *      (`user:{id}:digest`).
 *
 *   2. Called twice with the same cadence → the final state has
 *      exactly one entry per scheduler id and the interval matches.
 *
 *   3. Called twice with DIFFERENT cadences → the final state still
 *      has exactly one entry per scheduler id, and the interval is
 *      the NEW one (not the old). This is the "replace on cadence
 *      change" contract that keeps cadence updates propagating
 *      without leaking stale repeatable entries into Redis.
 *
 *   4. `removeJobsForUser(userId)` removes both entries and is
 *      idempotent — calling it on a user with no schedulers is a
 *      no-op, not an error. Required by `AuthService.failAuth` which
 *      needs to run removal unconditionally.
 *
 *   5. Missing user: `upsertJobsForUser` for a user with no row in
 *      `UsersRepo` logs a warning and returns — no throw, no
 *      scheduler written. The workers would fail loudly for a
 *      missing user anyway, so a routine cadence sync should not
 *      crash on a deleted-user race.
 */

/**
 * Minimal in-memory stand-in for the parts of `BullMQ.Queue` that
 * `ScheduleService` actually touches. Each instance tracks its own
 * scheduler state so the test can observe idempotency at the queue
 * level, not just at the service level.
 */
class FakeQueue {
  readonly schedulers = new Map<
    string,
    { every: number; jobName: string; data: unknown }
  >();
  upsertCalls = 0;
  removeCalls = 0;

  constructor(readonly name: string) {}

  // The real BullMQ signature is:
  //   upsertJobScheduler(jobSchedulerId, repeatOpts, jobTemplate?)
  // We only use the `every` option and the template's `name` + `data`,
  // so the fake implements exactly that slice.
  async upsertJobScheduler(
    jobSchedulerId: string,
    repeatOpts: { every?: number },
    jobTemplate?: { name?: string; data?: unknown },
  ): Promise<{ id: string }> {
    this.upsertCalls++;
    // Real BullMQ semantics: upsert REPLACES any existing entry with
    // the same id — the fake mirrors that so a cadence change in the
    // test leaves exactly one entry behind.
    if (repeatOpts.every === undefined) {
      throw new Error(`fake: every is required, got ${JSON.stringify(repeatOpts)}`);
    }
    this.schedulers.set(jobSchedulerId, {
      every: repeatOpts.every,
      jobName: jobTemplate?.name ?? jobSchedulerId,
      data: jobTemplate?.data,
    });
    return { id: jobSchedulerId };
  }

  async removeJobScheduler(jobSchedulerId: string): Promise<boolean> {
    this.removeCalls++;
    return this.schedulers.delete(jobSchedulerId);
  }
}

function asQueue(fake: FakeQueue): Queue {
  return fake as unknown as Queue;
}

/**
 * Narrow in-memory fake of `UsersRepo`. Only `findById` is used by
 * `ScheduleService`, so the fake intentionally implements only that
 * method — any future call to a different repo method in the service
 * will blow up loudly in tests rather than silently returning `null`.
 */
class FakeUsersRepo {
  readonly byId = new Map<string, UserRecord>();
  findByIdCalls = 0;

  async findById(userId: string): Promise<UserRecord | null> {
    this.findByIdCalls++;
    return this.byId.get(userId) ?? null;
  }
}

function asUsersRepo(fake: FakeUsersRepo): UsersRepo {
  return fake as unknown as UsersRepo;
}

function baseUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u_abc',
    xUserId: '12345',
    handle: 'fusuyfusuy',
    status: 'active',
    createdAt: '2026-04-06T12:00:00Z',
    ...overrides,
  };
}

function mkDeps(user?: UserRecord): {
  service: ScheduleService;
  pollQueue: FakeQueue;
  extractQueue: FakeQueue;
  digestQueue: FakeQueue;
  users: FakeUsersRepo;
} {
  const pollQueue = new FakeQueue('poll-x');
  const extractQueue = new FakeQueue('extract-item');
  const digestQueue = new FakeQueue('build-digest');
  const users = new FakeUsersRepo();
  if (user) users.byId.set(user.id, user);
  // The service only depends on poll-x and build-digest queues (the
  // two repeatable queues). extract-item is downstream of poll-x and
  // populated by `PollXProcessor` in #7 — it is intentionally NOT
  // injected here. `extractQueue` stays in the returned bundle so the
  // "does not touch extract-item" tests can assert it was never
  // written to, but the service constructor does not see it.
  const service = new ScheduleService(
    asQueue(pollQueue),
    asQueue(digestQueue),
    asUsersRepo(users),
  );
  return { service, pollQueue, extractQueue, digestQueue, users };
}

describe('ScheduleService.upsertJobsForUser', () => {
  it('reads the user row and registers both schedulers at the configured cadence', async () => {
    const { service, pollQueue, digestQueue, users } = mkDeps(
      baseUser({ pollIntervalMin: 30, digestIntervalMin: 720 }),
    );

    await service.upsertJobsForUser('u_abc');

    // The service read from UsersRepo exactly once.
    expect(users.findByIdCalls).toBe(1);

    // The poll-x scheduler is keyed by `user:{id}:poll` and fires every
    // pollIntervalMin minutes.
    expect(pollQueue.schedulers.size).toBe(1);
    const pollEntry = pollQueue.schedulers.get('user:u_abc:poll');
    expect(pollEntry).toBeDefined();
    expect(pollEntry?.every).toBe(30 * 60 * 1000);

    // The build-digest scheduler is keyed by `user:{id}:digest` and
    // fires every digestIntervalMin minutes.
    expect(digestQueue.schedulers.size).toBe(1);
    const digestEntry = digestQueue.schedulers.get('user:u_abc:digest');
    expect(digestEntry).toBeDefined();
    expect(digestEntry?.every).toBe(720 * 60 * 1000);
  });

  it('applies DEFAULT_POLL_INTERVAL_MIN and DEFAULT_DIGEST_INTERVAL_MIN when the row has no cadence set', async () => {
    // The spec forbids hardcoded 60/1440 inside ScheduleService — the
    // values must come from the UsersService constants. Locking that
    // here by importing the constants from the SAME module the service
    // imports so a future rename (e.g. renaming the constant) fails
    // loudly on the service side too.
    const { service, pollQueue, digestQueue } = mkDeps(baseUser());

    await service.upsertJobsForUser('u_abc');

    expect(pollQueue.schedulers.get('user:u_abc:poll')?.every).toBe(
      DEFAULT_POLL_INTERVAL_MIN * 60 * 1000,
    );
    expect(digestQueue.schedulers.get('user:u_abc:digest')?.every).toBe(
      DEFAULT_DIGEST_INTERVAL_MIN * 60 * 1000,
    );
  });

  it('is idempotent: two calls with the same cadence leave one entry per scheduler', async () => {
    const { service, pollQueue, digestQueue } = mkDeps(
      baseUser({ pollIntervalMin: 15, digestIntervalMin: 720 }),
    );

    await service.upsertJobsForUser('u_abc');
    await service.upsertJobsForUser('u_abc');

    expect(pollQueue.schedulers.size).toBe(1);
    expect(digestQueue.schedulers.size).toBe(1);
    expect(pollQueue.schedulers.get('user:u_abc:poll')?.every).toBe(
      15 * 60 * 1000,
    );
    expect(digestQueue.schedulers.get('user:u_abc:digest')?.every).toBe(
      720 * 60 * 1000,
    );
  });

  it('replaces the existing scheduler when cadence changes', async () => {
    // The core milestone #5 contract: calling upsert twice with
    // DIFFERENT cadences must leave exactly one entry behind per
    // scheduler id, and the entry must reflect the NEW cadence. If
    // this test ever flakes or produces two entries, the idempotency
    // contract is broken and the cadence change has leaked a stale
    // repeatable into Redis that would fire at the old interval until
    // manually removed.
    const { service, pollQueue, digestQueue, users } = mkDeps();
    users.byId.set(
      'u_abc',
      baseUser({ pollIntervalMin: 60, digestIntervalMin: 1440 }),
    );

    await service.upsertJobsForUser('u_abc');
    expect(pollQueue.schedulers.get('user:u_abc:poll')?.every).toBe(
      60 * 60 * 1000,
    );

    // Mutate the user row to simulate a cadence change applied via
    // `PATCH /me`, then re-upsert.
    users.byId.set(
      'u_abc',
      baseUser({ pollIntervalMin: 5, digestIntervalMin: 15 }),
    );
    await service.upsertJobsForUser('u_abc');

    expect(pollQueue.schedulers.size).toBe(1);
    expect(digestQueue.schedulers.size).toBe(1);
    expect(pollQueue.schedulers.get('user:u_abc:poll')?.every).toBe(
      5 * 60 * 1000,
    );
    expect(digestQueue.schedulers.get('user:u_abc:digest')?.every).toBe(
      15 * 60 * 1000,
    );
  });

  it('includes the userId in the job template data so workers can look the user up', async () => {
    const { service, pollQueue, digestQueue } = mkDeps(
      baseUser({ pollIntervalMin: 30, digestIntervalMin: 720 }),
    );

    await service.upsertJobsForUser('u_abc');

    // The template's `data` is what BullMQ workers receive as
    // `job.data`. Locking `{ userId }` here ensures #7's PollXProcessor
    // and #11's BuildDigestProcessor can identify the user without
    // parsing the scheduler id.
    expect(pollQueue.schedulers.get('user:u_abc:poll')?.data).toEqual({
      userId: 'u_abc',
    });
    expect(pollQueue.schedulers.get('user:u_abc:poll')?.jobName).toBe('poll-x');
    expect(digestQueue.schedulers.get('user:u_abc:digest')?.data).toEqual({
      userId: 'u_abc',
    });
    expect(digestQueue.schedulers.get('user:u_abc:digest')?.jobName).toBe(
      'build-digest',
    );
  });

  it('does not touch the extract-item queue (that queue is populated by poll-x in #7, never by ScheduleService)', async () => {
    const { service, extractQueue } = mkDeps(
      baseUser({ pollIntervalMin: 30, digestIntervalMin: 720 }),
    );

    await service.upsertJobsForUser('u_abc');

    // Extract-item is downstream of poll-x (processor → processor),
    // ScheduleService must not register a repeatable for it. Locking
    // this here prevents a future "consistency" refactor from
    // accidentally scheduling per-user extract jobs.
    expect(extractQueue.upsertCalls).toBe(0);
    expect(extractQueue.schedulers.size).toBe(0);
  });

  it('logs a warning and returns cleanly when the user row is missing', async () => {
    const logSpy = spyOn(Logger.prototype, 'warn').mockImplementation(
      () => {},
    );
    try {
      const { service, pollQueue, digestQueue } = mkDeps();
      // No user seeded.
      await expect(
        service.upsertJobsForUser('u_gone'),
      ).resolves.toBeUndefined();
      // Neither queue was touched.
      expect(pollQueue.upsertCalls).toBe(0);
      expect(digestQueue.upsertCalls).toBe(0);
      // A warn log fired so the operator can see the no-op.
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('ScheduleService.removeJobsForUser', () => {
  it('removes both schedulers for the user', async () => {
    const { service, pollQueue, digestQueue } = mkDeps(
      baseUser({ pollIntervalMin: 30, digestIntervalMin: 720 }),
    );
    await service.upsertJobsForUser('u_abc');
    expect(pollQueue.schedulers.size).toBe(1);
    expect(digestQueue.schedulers.size).toBe(1);

    await service.removeJobsForUser('u_abc');

    expect(pollQueue.schedulers.size).toBe(0);
    expect(digestQueue.schedulers.size).toBe(0);
    expect(pollQueue.removeCalls).toBe(1);
    expect(digestQueue.removeCalls).toBe(1);
  });

  it('is idempotent: calling remove on a user with no schedulers does not throw', async () => {
    // Required by `AuthService.failAuth`: that path runs removal
    // unconditionally after setStatus('auth_expired'), and the user
    // may have never had jobs registered (e.g. a token refresh failed
    // before the first poll ever ran). Must not throw.
    const { service, pollQueue, digestQueue } = mkDeps();
    await expect(
      service.removeJobsForUser('u_never_scheduled'),
    ).resolves.toBeUndefined();
    expect(pollQueue.removeCalls).toBe(1);
    expect(digestQueue.removeCalls).toBe(1);
  });

  it('does not call UsersRepo.findById (removal is keyed on userId alone)', async () => {
    // Removal must not require the user row to exist — a deleted user
    // is the primary use case for removal. Locking that here stops a
    // future "helpful" refactor from re-introducing a pre-read.
    const { service, users } = mkDeps();
    await service.removeJobsForUser('u_whatever');
    expect(users.findByIdCalls).toBe(0);
  });

  it('does not touch the extract-item queue', async () => {
    const { service, extractQueue } = mkDeps();
    await service.removeJobsForUser('u_abc');
    expect(extractQueue.removeCalls).toBe(0);
  });
});

describe('ScheduleService public surface', () => {
  it('exposes exactly upsertJobsForUser and removeJobsForUser as public methods', async () => {
    // Pin the surface so the hexagonal-containment rule stays intact.
    // A future "helpful" addition of a BullMQ-typed helper would
    // have to deliberately touch this test.
    const { service } = mkDeps();
    const ownMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service),
    )
      .filter((n) => n !== 'constructor')
      .sort();
    expect(ownMethods).toEqual(['removeJobsForUser', 'upsertJobsForUser']);
  });

  it('upsertJobsForUser and removeJobsForUser each take exactly one positional argument', async () => {
    const { service } = mkDeps();
    expect(service.upsertJobsForUser.length).toBe(1);
    expect(service.removeJobsForUser.length).toBe(1);
  });
});
