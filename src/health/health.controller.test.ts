import { describe, expect, it } from 'bun:test';
import type { AppwritePingResult, AppwriteService } from '../appwrite/appwrite.service';
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

describe('HealthController', () => {
  it('returns { status: "ok", appwrite: { status: "ok" } } when Appwrite is healthy', async () => {
    const controller = new HealthController(fakeAppwrite({ status: 'ok' }));
    const result = await controller.check();
    expect(result).toEqual({ status: 'ok', appwrite: { status: 'ok' } });
  });

  it('returns the failing appwrite subsystem state when Appwrite is down', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'down', error: 'connection refused' }),
    );
    const result = await controller.check();
    expect(result.status).toBe('ok'); // process is alive even if subsystem is not
    expect(result.appwrite.status).toBe('down');
    if (result.appwrite.status === 'down') {
      expect(result.appwrite.error).toBe('connection refused');
    }
  });

  it('does not throw when AppwriteService.ping resolves to a down state', async () => {
    const controller = new HealthController(
      fakeAppwrite({ status: 'down', error: 'boom' }),
    );
    await expect(controller.check()).resolves.toBeDefined();
  });
});
