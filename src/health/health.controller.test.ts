import { describe, expect, it } from 'bun:test';
import type { AppwritePingResult, AppwriteService } from '../appwrite/appwrite.service';
import type { RedisHealthPort } from '../queue/queue.tokens';
import type { RedisPingResult } from '../queue/redis.connection';
import { HealthController } from './health.controller';

function fakeAppwrite(result: AppwritePingResult): AppwriteService {
  return {
    get databaseId() {
      return 'xreporter_test';
    },
    async ping() {
      return result;
    },
  } as unknown as AppwriteService;
}

/**
 * Minimal stub of the `REDIS_HEALTH` token. The controller only ever
 * calls `.ping()`, so the fake implements exactly that — anything else
 * would be future-proofing for a contract the controller doesn't
 * actually depend on, and that's the kind of test scaffolding that
 * accidentally hides hexagonal violations later.
 */
function fakeRedisHealth(result: RedisPingResult): RedisHealthPort {
  return {
    async ping() {
      return result;
    },
  };
}

describe('HealthController', () => {
  it('returns { status: "ok", appwrite: ok, redis: ok } when both subsystems are healthy', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'ok' }),
      fakeRedisHealth({ status: 'ok' }),
    );
    const result = await controller.check();
    expect(result).toEqual({
      status: 'ok',
      appwrite: { status: 'ok' },
      redis: { status: 'ok' },
    });
  });

  it('returns the failing appwrite subsystem state when Appwrite is down', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'down', error: 'connection refused' }),
      fakeRedisHealth({ status: 'ok' }),
    );
    const result = await controller.check();
    expect(result.status).toBe('ok'); // process is alive even if subsystem is not
    expect(result.appwrite.status).toBe('down');
    if (result.appwrite.status === 'down') {
      expect(result.appwrite.error).toBe('connection refused');
    }
    expect(result.redis.status).toBe('ok');
  });

  it('returns the failing redis subsystem state when Redis is down', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'ok' }),
      fakeRedisHealth({ status: 'down', error: 'redis ping failed: ECONNREFUSED' }),
    );
    const result = await controller.check();
    // HTTP-level status stays 'ok' because the existing /health policy is
    // "always return 200; the body distinguishes subsystem health". A
    // future milestone may switch to 503 once the project has a uniform
    // policy across all subsystems.
    expect(result.status).toBe('ok');
    expect(result.appwrite.status).toBe('ok');
    expect(result.redis.status).toBe('down');
    if (result.redis.status === 'down') {
      expect(result.redis.error).toBe('redis ping failed: ECONNREFUSED');
    }
  });

  it('returns both subsystem failures simultaneously when both are down', async () => {
    // Independence check: the controller never short-circuits one
    // subsystem because the other failed. Both probes always run and
    // both results always reach the response body. This is what makes
    // the /health endpoint useful for narrowing the failure domain
    // when multiple things go wrong at once.
    const controller = new HealthController(
      fakeAppwrite({ status: 'down', error: 'appwrite outage' }),
      fakeRedisHealth({ status: 'down', error: 'redis outage' }),
    );
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(result.appwrite.status).toBe('down');
    expect(result.redis.status).toBe('down');
  });

  it('does not throw when AppwriteService.ping resolves to a down state', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'down', error: 'boom' }),
      fakeRedisHealth({ status: 'ok' }),
    );
    await expect(controller.check()).resolves.toBeDefined();
  });

  it('does not throw when the Redis health helper resolves to a down state', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'ok' }),
      fakeRedisHealth({ status: 'down', error: 'boom' }),
    );
    await expect(controller.check()).resolves.toBeDefined();
  });
});
