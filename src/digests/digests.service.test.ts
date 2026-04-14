import { describe, expect, it } from 'bun:test';
import type { DigestRecord, ListDigestsInput } from '../workers/digests.repo';
import {
  DIGEST_PREVIEW_LENGTH,
  DigestsService,
  type BuildDigestQueueProducer,
} from './digests.service';

class FakeDigestsRepo {
  listCalls: ListDigestsInput[] = [];
  listResult: { items: DigestRecord[]; nextCursor?: string } = { items: [] };
  rows = new Map<string, DigestRecord>();

  async listByUser(input: ListDigestsInput) {
    this.listCalls.push(input);
    return this.listResult;
  }

  async findByIdAndUser(
    digestId: string,
    userId: string,
  ): Promise<DigestRecord | null> {
    const row = this.rows.get(digestId);
    if (!row || row.userId !== userId) return null;
    return row;
  }
}

class FakeQueue implements BuildDigestQueueProducer {
  calls: Array<{ name: string; data: unknown; opts?: Record<string, unknown> }> = [];
  nextId = 'job-1';

  async add(name: string, data: unknown, opts?: Record<string, unknown>) {
    this.calls.push({ name, data, opts });
    return { id: this.nextId };
  }
}

function makeService(): {
  service: DigestsService;
  repo: FakeDigestsRepo;
  queue: FakeQueue;
} {
  const repo = new FakeDigestsRepo();
  const queue = new FakeQueue();
  const service = new DigestsService(repo as never, queue);
  return { service, repo, queue };
}

function makeRow(overrides: Partial<DigestRecord> = {}): DigestRecord {
  return {
    id: 'd1',
    userId: 'u1',
    windowStart: '2026-04-05T00:00:00.000Z',
    windowEnd: '2026-04-06T00:00:00.000Z',
    markdown: '## digest',
    itemIds: ['i1'],
    model: 'anthropic/claude-sonnet-4.5',
    tokensIn: 10,
    tokensOut: 5,
    createdAt: '2026-04-06T00:05:12.000Z',
    ...overrides,
  };
}

describe('DigestsService.list', () => {
  it('delegates to repo.listByUser and attaches preview', async () => {
    const { service, repo } = makeService();
    repo.listResult = {
      items: [makeRow({ id: 'd1', markdown: '## hi' })],
    };
    const result = await service.list('u1', 20, undefined);
    expect(repo.listCalls[0]).toEqual({ userId: 'u1', limit: 20 });
    expect(result.items[0]).toMatchObject({
      id: 'd1',
      preview: '## hi',
      model: 'anthropic/claude-sonnet-4.5',
    });
    // No full markdown / tokens on list rows.
    expect((result.items[0] as unknown as Record<string, unknown>).markdown).toBeUndefined();
    expect(result.nextCursor).toBeUndefined();
  });

  it('truncates markdown to DIGEST_PREVIEW_LENGTH for the preview', async () => {
    const { service, repo } = makeService();
    const long = 'a'.repeat(DIGEST_PREVIEW_LENGTH * 2);
    repo.listResult = { items: [makeRow({ markdown: long })] };
    const result = await service.list('u1', 20, undefined);
    expect(result.items[0]!.preview).toHaveLength(DIGEST_PREVIEW_LENGTH);
  });

  it('forwards cursor and nextCursor', async () => {
    const { service, repo } = makeService();
    repo.listResult = { items: [makeRow()], nextCursor: 'd_prev' };
    const result = await service.list('u1', 5, 'd_start');
    expect(repo.listCalls[0]).toEqual({ userId: 'u1', limit: 5, cursor: 'd_start' });
    expect(result.nextCursor).toBe('d_prev');
  });
});

describe('DigestsService.getById', () => {
  it('returns the row when owned', async () => {
    const { service, repo } = makeService();
    const row = makeRow({ id: 'd1', userId: 'u1' });
    repo.rows.set('d1', row);
    const found = await service.getById('u1', 'd1');
    expect(found).toEqual(row);
  });

  it('returns null when not owned', async () => {
    const { service, repo } = makeService();
    repo.rows.set('d1', makeRow({ id: 'd1', userId: 'u2' }));
    const found = await service.getById('u1', 'd1');
    expect(found).toBeNull();
  });
});

describe('DigestsService.enqueueRunNow', () => {
  it('enqueues with the documented retry policy and returns jobId + queuedAt', async () => {
    const { service, queue } = makeService();
    queue.nextId = 'job-42';
    const result = await service.enqueueRunNow('u1');
    expect(result.jobId).toBe('job-42');
    expect(typeof result.queuedAt).toBe('string');
    expect(queue.calls[0]!.name).toBe('build-digest');
    expect(queue.calls[0]!.data).toEqual({ userId: 'u1' });
    const opts = queue.calls[0]!.opts!;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 60_000 });
  });
});
