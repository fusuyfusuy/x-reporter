import { describe, expect, it } from 'bun:test';
import { createRedisClient, pingRedis } from './redis.connection';

/**
 * Unit tests for the Redis connection factory and the ping helper.
 *
 * These tests deliberately avoid talking to a real Redis: the factory is
 * a pure constructor call (no TCP connection because of `lazyConnect`),
 * and `pingRedis` is exercised against a hand-rolled stub that implements
 * only `.ping()`. The real factory surface is narrow enough that a full
 * ioredis lift-and-shift test would tell us nothing this cannot.
 */

describe('createRedisClient', () => {
  it('returns an ioredis client with the BullMQ-required options applied', () => {
    const client = createRedisClient('redis://localhost:6379');
    try {
      // BullMQ workers refuse to start without maxRetriesPerRequest: null.
      // Lock that at construction time so the footgun cannot surface in #7.
      expect(client.options.maxRetriesPerRequest).toBeNull();
      // enableReadyCheck: false avoids slow boot in CI where Redis takes
      // a moment to accept commands after starting.
      expect(client.options.enableReadyCheck).toBe(false);
      // lazyConnect: true so a construction call in unit tests does not
      // immediately open a TCP socket.
      expect(client.options.lazyConnect).toBe(true);
      // Port parsed from the URL.
      expect(client.options.port).toBe(6379);
      expect(client.options.host).toBe('localhost');
    } finally {
      // Client was lazy — nothing to tear down, but be explicit.
      client.disconnect();
    }
  });

  it('accepts a custom port from the URL', () => {
    const client = createRedisClient('redis://127.0.0.1:6380');
    try {
      expect(client.options.port).toBe(6380);
      expect(client.options.host).toBe('127.0.0.1');
    } finally {
      client.disconnect();
    }
  });
});

describe('pingRedis', () => {
  it('returns { status: "ok" } when the client ping resolves with PONG', async () => {
    const fake = {
      async ping() {
        return 'PONG';
      },
    };
    const result = await pingRedis(fake as unknown as Parameters<typeof pingRedis>[0]);
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns { status: "ok" } on any successful resolution (ioredis returns string "PONG")', async () => {
    // ioredis returns 'PONG' (uppercase). Accept any successful resolution
    // so a future client swap that returns e.g. 'pong' does not flake.
    const fake = {
      async ping() {
        return 'pong';
      },
    };
    const result = await pingRedis(fake as unknown as Parameters<typeof pingRedis>[0]);
    expect(result).toEqual({ status: 'ok' });
  });

  it('returns { status: "down", error } when the client ping rejects', async () => {
    const fake = {
      async ping() {
        throw new Error('connection refused');
      },
    };
    const result = await pingRedis(fake as unknown as Parameters<typeof pingRedis>[0]);
    expect(result.status).toBe('down');
    if (result.status === 'down') {
      expect(result.error).toContain('connection refused');
    }
  });

  it('never throws, even when the ping throws a non-Error value', async () => {
    const fake = {
      async ping() {
        // biome-ignore lint/suspicious/useAwait: intentional reject with non-Error
        throw 'string-reason';
      },
    };
    const result = await pingRedis(fake as unknown as Parameters<typeof pingRedis>[0]);
    expect(result.status).toBe('down');
    if (result.status === 'down') {
      expect(result.error).toContain('string-reason');
    }
  });
});
