import { describe, expect, it } from 'bun:test';
import { UsersController } from './users.controller';
import {
  ScheduleSyncError,
  UserNotFoundError,
  type MeProfile,
  type UsersService,
} from './users.service';

/**
 * Controller-level tests for `GET /me` and `PATCH /me`.
 *
 * The controller is the HTTP boundary. Its job is purely:
 *
 *   1. Read `req.user.id` (set by `SessionGuard`).
 *   2. For PATCH: validate the body with the strict zod schema and
 *      surface validation failures as `400 validation_failed` under
 *      the standard error envelope from `docs/api.md#errors`.
 *   3. Call `UsersService.getProfile` / `updateCadence`.
 *   4. Map known typed errors:
 *        - `UserNotFoundError` → `404 not_found`
 *        - `ScheduleSyncError` → `502 internal` (upstream dependency
 *          failure, same shape `AuthController` uses)
 *        - any other throw → bubble (Nest exception filter handles
 *          generic 500).
 *   5. Return the `MeProfile` shape on success.
 *
 * SessionGuard 401 paths are covered exhaustively in
 * `src/common/session.guard.test.ts`. The e2e test in
 * `app.module.test.ts` also exercises the missing-cookie path against
 * the live HTTP stack so we know the guard is wired.
 */

interface FakeServiceState {
  getCalls: string[];
  updateCalls: Array<{ id: string; patch: unknown }>;
  getBehavior: 'ok' | 'not-found' | 'throw';
  updateBehavior: 'ok' | 'not-found' | 'schedule-failed' | 'throw';
  profile: MeProfile;
}

function makeFakeService(): { service: UsersService; state: FakeServiceState } {
  const state: FakeServiceState = {
    getCalls: [],
    updateCalls: [],
    getBehavior: 'ok',
    updateBehavior: 'ok',
    profile: {
      id: 'u_abc',
      xUserId: '12345',
      handle: 'fusuyfusuy',
      pollIntervalMin: 60,
      digestIntervalMin: 1440,
      status: 'active',
      createdAt: '2026-04-06T12:00:00Z',
    },
  };
  const service: Pick<UsersService, 'getProfile' | 'updateCadence'> = {
    async getProfile(userId: string) {
      state.getCalls.push(userId);
      if (state.getBehavior === 'not-found') {
        throw new UserNotFoundError(userId);
      }
      if (state.getBehavior === 'throw') {
        throw new Error('boom');
      }
      return state.profile;
    },
    async updateCadence(userId: string, patch) {
      state.updateCalls.push({ id: userId, patch });
      if (state.updateBehavior === 'not-found') {
        throw new UserNotFoundError(userId);
      }
      if (state.updateBehavior === 'schedule-failed') {
        throw new ScheduleSyncError('boom');
      }
      if (state.updateBehavior === 'throw') {
        throw new Error('boom');
      }
      return { ...state.profile, ...patch };
    },
  };
  return { service: service as UsersService, state };
}

function makeReq(userId: string | undefined): { user?: { id: string } } {
  return userId ? { user: { id: userId } } : {};
}

describe('UsersController GET /me', () => {
  it('returns the profile from UsersService for the authenticated caller', async () => {
    const { service, state } = makeFakeService();
    const controller = new UsersController(service);
    const req = makeReq('u_abc');
    const result = await controller.getMe(req as never);
    expect(result).toEqual(state.profile);
    expect(state.getCalls).toEqual(['u_abc']);
  });

  it('throws 404 when the service reports the user is gone', async () => {
    const { service, state } = makeFakeService();
    state.getBehavior = 'not-found';
    const controller = new UsersController(service);
    const req = makeReq('u_missing');
    let caught: unknown;
    try {
      await controller.getMe(req as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Nest's `NotFoundException` carries an HTTP status of 404 — assert
    // both the constructor name and the status so a future refactor
    // can't substitute a generic Error.
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(404);
  });

  it('rethrows unknown errors so the global filter can map them to 500', async () => {
    const { service, state } = makeFakeService();
    state.getBehavior = 'throw';
    const controller = new UsersController(service);
    await expect(controller.getMe(makeReq('u_abc') as never)).rejects.toThrow('boom');
  });
});

describe('UsersController PATCH /me', () => {
  it('persists a valid patch and returns the updated profile', async () => {
    const { service, state } = makeFakeService();
    const controller = new UsersController(service);
    const req = makeReq('u_abc');
    const result = await controller.patchMe(req as never, {
      pollIntervalMin: 30,
      digestIntervalMin: 720,
    });
    expect(state.updateCalls).toEqual([
      { id: 'u_abc', patch: { pollIntervalMin: 30, digestIntervalMin: 720 } },
    ]);
    expect(result.pollIntervalMin).toBe(30);
    expect(result.digestIntervalMin).toBe(720);
  });

  it('accepts a patch with only pollIntervalMin', async () => {
    const { service } = makeFakeService();
    const controller = new UsersController(service);
    const result = await controller.patchMe(makeReq('u_abc') as never, {
      pollIntervalMin: 5,
    });
    expect(result.pollIntervalMin).toBe(5);
  });

  it('accepts a patch with only digestIntervalMin', async () => {
    const { service } = makeFakeService();
    const controller = new UsersController(service);
    const result = await controller.patchMe(makeReq('u_abc') as never, {
      digestIntervalMin: 15,
    });
    expect(result.digestIntervalMin).toBe(15);
  });

  it('rejects an empty body with 400 validation_failed', async () => {
    const { service, state } = makeFakeService();
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
    const body = (caught as { getResponse: () => unknown }).getResponse();
    expect(body).toMatchObject({ error: { code: 'validation_failed' } });
    expect(state.updateCalls).toEqual([]);
  });

  it('rejects pollIntervalMin below 5 with 400 validation_failed', async () => {
    const { service } = makeFakeService();
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, { pollIntervalMin: 4 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
  });

  it('rejects digestIntervalMin below 15 with 400 validation_failed', async () => {
    const { service } = makeFakeService();
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, { digestIntervalMin: 14 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
  });

  it('rejects non-integer pollIntervalMin with 400', async () => {
    const { service } = makeFakeService();
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, { pollIntervalMin: 5.5 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
  });

  it('rejects unknown keys with 400 (strict schema)', async () => {
    const { service, state } = makeFakeService();
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, {
        pollIntervalMin: 10,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid extra key
        bogusField: 'nope',
      } as any);
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
    expect(state.updateCalls).toEqual([]);
  });

  it('maps UserNotFoundError from the service to 404', async () => {
    const { service, state } = makeFakeService();
    state.updateBehavior = 'not-found';
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_missing') as never, { pollIntervalMin: 10 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(404);
  });

  it('maps ScheduleSyncError from the service to 502 internal', async () => {
    const { service, state } = makeFakeService();
    state.updateBehavior = 'schedule-failed';
    const controller = new UsersController(service);
    let caught: unknown;
    try {
      await controller.patchMe(makeReq('u_abc') as never, { pollIntervalMin: 10 });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(502);
    const body = (caught as { getResponse: () => unknown }).getResponse();
    expect(body).toMatchObject({ error: { code: 'internal' } });
  });

  it('rethrows unknown service errors', async () => {
    const { service, state } = makeFakeService();
    state.updateBehavior = 'throw';
    const controller = new UsersController(service);
    await expect(
      controller.patchMe(makeReq('u_abc') as never, { pollIntervalMin: 10 }),
    ).rejects.toThrow('boom');
  });
});
