import { describe, expect, it } from 'bun:test';
import { DigestsController } from './digests.controller';
import type {
  DigestDetail,
  DigestListResponse,
  DigestsService,
  RunNowResult,
} from './digests.service';

/**
 * HTTP boundary tests for `DigestsController`. Covers the acceptance
 * criteria from issue #11:
 *
 *   - `GET /digests` validates the query string with a strict zod
 *     schema and delegates to `DigestsService.list`.
 *   - `GET /digests/:id` returns the full row when owned, 404 when
 *     not (collapsing "missing" and "not owned" to the same status).
 *   - `POST /digests/run-now` answers `202` with `{ jobId }`.
 *
 * Fakes mirror the pattern in `users.controller.test.ts`.
 */

interface FakeServiceState {
  listCalls: Array<{ userId: string; limit: number; cursor?: string }>;
  getCalls: Array<{ userId: string; id: string }>;
  runCalls: string[];
  listResult: DigestListResponse;
  getResult: DigestDetail | null;
  runResult: RunNowResult;
}

function makeFakeService(): {
  service: DigestsService;
  state: FakeServiceState;
} {
  const state: FakeServiceState = {
    listCalls: [],
    getCalls: [],
    runCalls: [],
    listResult: { items: [] },
    getResult: null,
    runResult: { jobId: 'job-1', queuedAt: '2026-04-06T00:00:00.000Z' },
  };
  const service: Pick<DigestsService, 'list' | 'getById' | 'enqueueRunNow'> = {
    async list(userId, limit, cursor) {
      const call: { userId: string; limit: number; cursor?: string } = {
        userId,
        limit,
      };
      if (cursor !== undefined) call.cursor = cursor;
      state.listCalls.push(call);
      return state.listResult;
    },
    async getById(userId, id) {
      state.getCalls.push({ userId, id });
      return state.getResult;
    },
    async enqueueRunNow(userId) {
      state.runCalls.push(userId);
      return state.runResult;
    },
  };
  return { service: service as DigestsService, state };
}

function makeReq(userId: string | undefined): { user?: { id: string } } {
  return userId ? { user: { id: userId } } : {};
}

describe('DigestsController GET /digests', () => {
  it('calls the service with defaults when no query params are provided', async () => {
    const { service, state } = makeFakeService();
    const controller = new DigestsController(service);
    state.listResult = { items: [] };
    await controller.list(makeReq('u1') as never, {});
    expect(state.listCalls).toEqual([{ userId: 'u1', limit: 20 }]);
  });

  it('forwards limit and cursor from the query string', async () => {
    const { service, state } = makeFakeService();
    const controller = new DigestsController(service);
    await controller.list(makeReq('u1') as never, { limit: '5', cursor: 'd_x' });
    expect(state.listCalls[0]).toEqual({ userId: 'u1', limit: 5, cursor: 'd_x' });
  });

  it('rejects limit <= 0 with 400 validation_failed', async () => {
    const { service } = makeFakeService();
    const controller = new DigestsController(service);
    let caught: unknown;
    try {
      await controller.list(makeReq('u1') as never, { limit: '0' });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
    const body = (caught as { getResponse: () => unknown }).getResponse();
    expect(body).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('rejects unknown query keys (strict schema)', async () => {
    const { service } = makeFakeService();
    const controller = new DigestsController(service);
    let caught: unknown;
    try {
      await controller.list(makeReq('u1') as never, { bogus: 'x' });
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(400);
  });

  it('throws 401 when req.user is missing', async () => {
    const { service } = makeFakeService();
    const controller = new DigestsController(service);
    let caught: unknown;
    try {
      await controller.list({} as never, {});
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(401);
  });
});

describe('DigestsController GET /digests/:id', () => {
  it('returns the service result when owned', async () => {
    const { service, state } = makeFakeService();
    const controller = new DigestsController(service);
    const row = {
      id: 'd1',
      userId: 'u1',
      windowStart: '2026-04-05T00:00:00.000Z',
      windowEnd: '2026-04-06T00:00:00.000Z',
      markdown: '## hi',
      itemIds: ['i1'],
      model: 'anthropic/claude-sonnet-4.5',
      tokensIn: 1,
      tokensOut: 2,
      createdAt: '2026-04-06T00:05:00.000Z',
    };
    state.getResult = row;
    const result = await controller.getById(makeReq('u1') as never, 'd1');
    expect(result).toEqual(row);
    expect(state.getCalls).toEqual([{ userId: 'u1', id: 'd1' }]);
  });

  it('returns 404 with the documented envelope when the service returns null', async () => {
    const { service, state } = makeFakeService();
    const controller = new DigestsController(service);
    state.getResult = null;
    let caught: unknown;
    try {
      await controller.getById(makeReq('u1') as never, 'd_other');
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(404);
    const body = (caught as { getResponse: () => unknown }).getResponse();
    expect(body).toMatchObject({ error: { code: 'not_found', details: {} } });
  });
});

describe('DigestsController POST /digests/run-now', () => {
  it('enqueues a job and returns the job id', async () => {
    const { service, state } = makeFakeService();
    const controller = new DigestsController(service);
    state.runResult = { jobId: 'job-42', queuedAt: '2026-04-06T00:00:00.000Z' };
    const result = await controller.runNow(makeReq('u1') as never);
    expect(state.runCalls).toEqual(['u1']);
    expect(result).toEqual({ jobId: 'job-42', queuedAt: '2026-04-06T00:00:00.000Z' });
  });

  it('throws 401 when req.user is missing', async () => {
    const { service } = makeFakeService();
    const controller = new DigestsController(service);
    let caught: unknown;
    try {
      await controller.runNow({} as never);
    } catch (err) {
      caught = err;
    }
    expect((caught as { getStatus?: () => number }).getStatus?.()).toBe(401);
  });
});
