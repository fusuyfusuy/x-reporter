import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ScheduleService } from './schedule.service';

/**
 * Stub `ScheduleService` tests.
 *
 * The real BullMQ-backed implementation lands in milestone #5
 * (`feat(queue): BullMQ infra + ScheduleService`). For #4 we only need
 * to verify the stub:
 *
 *   1. Resolves cleanly for any user id (no exception).
 *   2. Logs the call so the cadence-update side effect is observable
 *      end-to-end during the milestone window where the real impl is
 *      not yet wired.
 *   3. Has the documented adapter-free public surface — no BullMQ
 *      types, no `Queue` references, no Redis SDK leak. (This is
 *      enforced by TypeScript at compile time, but we assert the
 *      method signature shape here so a future "helpful" refactor that
 *      adds an options param doesn't slip through.)
 */

describe('ScheduleService (stub)', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on the Nest Logger prototype rather than constructing a fake
    // — that way we don't have to thread a logger param through the
    // constructor and the test still observes the same call site the
    // real impl in #5 will have.
    logSpy = spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('resolves for a valid user id', async () => {
    const service = new ScheduleService();
    await expect(service.upsertJobsForUser('u_abc')).resolves.toBeUndefined();
  });

  it('logs the call so the side effect is observable in #4', async () => {
    const service = new ScheduleService();
    await service.upsertJobsForUser('u_abc');
    expect(logSpy).toHaveBeenCalled();
    const firstArg = logSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('string');
    expect(String(firstArg)).toContain('u_abc');
    // The log line must mention that this is the stub, not the real
    // BullMQ impl, so a tail of the logs during dev makes the
    // milestone boundary obvious.
    expect(String(firstArg)).toContain('stub');
  });

  it('does not throw on repeated calls (idempotent shape)', async () => {
    const service = new ScheduleService();
    await service.upsertJobsForUser('u_abc');
    await service.upsertJobsForUser('u_abc');
    await service.upsertJobsForUser('u_xyz');
    expect(logSpy).toHaveBeenCalledTimes(3);
  });

  it('exposes upsertJobsForUser as the only public method on the surface', () => {
    // Belt-and-braces against accidental surface growth. The hexagonal
    // rule (swe-config.json) says ScheduleService must keep its public
    // surface adapter-free so #5 can swap in BullMQ without churning
    // consumers. The cheapest way to enforce that for the stub is to
    // pin the public method list.
    const service = new ScheduleService();
    const ownMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service),
    ).filter((name) => name !== 'constructor');
    expect(ownMethods).toEqual(['upsertJobsForUser']);
  });

  it('upsertJobsForUser takes exactly one positional argument', () => {
    // Pin the arity so the BullMQ swap in #5 cannot accidentally widen
    // the contract (e.g. adding `(userId, opts)`) without breaking the
    // test and forcing a deliberate update of consumers + spec.
    const service = new ScheduleService();
    expect(service.upsertJobsForUser.length).toBe(1);
  });
});
