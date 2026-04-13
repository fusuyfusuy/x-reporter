import { describe, expect, it } from 'bun:test';
import { AppwriteService } from './appwrite.service';

const baseEnv = {
  PORT: 3000 as const,
  NODE_ENV: 'test' as const,
  APPWRITE_ENDPOINT: 'https://appwrite.test/v1',
  APPWRITE_PROJECT_ID: 'proj_test',
  APPWRITE_API_KEY: 'key_test',
  APPWRITE_DATABASE_ID: 'xreporter_test',
  REDIS_URL: 'redis://localhost:6379',
  X_CLIENT_ID: 'x_client_id',
  X_CLIENT_SECRET: 'x_client_secret',
  X_REDIRECT_URI: 'http://localhost:3000/auth/x/callback',
  X_SCOPES: 'tweet.read users.read offline.access',
  TOKEN_ENC_KEY: Buffer.alloc(32, 0).toString('base64'),
  SESSION_SECRET: 'a-test-session-secret-at-least-32-chars-long',
  LLM_PROVIDER: 'openrouter' as const,
  OPENROUTER_MODEL: 'anthropic/claude-sonnet-4.5',
  EXTRACTOR: 'firecrawl' as const,
  POLL_X_CONCURRENCY: 5,
  EXTRACT_ITEM_CONCURRENCY: 10,
  BUILD_DIGEST_CONCURRENCY: 2,
};

/**
 * Build a fake `Databases` SDK handle that resolves or rejects on `get`,
 * matching only the surface `AppwriteService.ping()` actually consumes.
 */
function fakeDatabases(behavior: 'ok' | 'down') {
  return {
    get: async ({ databaseId }: { databaseId: string }) => {
      if (behavior === 'down') {
        throw new Error(`fake outage for ${databaseId}`);
      }
      return { $id: databaseId, name: 'fake' };
    },
  };
}

describe('AppwriteService', () => {
  describe('databaseId', () => {
    it('returns the value from env', () => {
      const svc = new AppwriteService(baseEnv);
      expect(svc.databaseId).toBe('xreporter_test');
    });
  });

  describe('ping', () => {
    it('returns { status: "ok" } when the SDK call resolves', async () => {
      const svc = new AppwriteService(baseEnv);
      // Inject a fake databases handle through the test seam.
      svc.__setDatabasesForTesting(fakeDatabases('ok') as never);
      const result = await svc.ping();
      expect(result).toEqual({ status: 'ok' });
    });

    it('returns { status: "down" } with the error message when the SDK call rejects', async () => {
      const svc = new AppwriteService(baseEnv);
      svc.__setDatabasesForTesting(fakeDatabases('down') as never);
      const result = await svc.ping();
      expect(result.status).toBe('down');
      if (result.status === 'down') {
        expect(result.error).toContain('fake outage');
        expect(result.error).toContain('xreporter_test');
      }
    });

    it('never throws even when the SDK throws synchronously', async () => {
      const svc = new AppwriteService(baseEnv);
      svc.__setDatabasesForTesting({
        get: () => {
          throw new Error('boom');
        },
      } as never);
      const result = await svc.ping();
      expect(result.status).toBe('down');
    });
  });

  describe('databases accessor', () => {
    it('exposes the underlying typed databases handle for the bootstrap script', () => {
      const svc = new AppwriteService(baseEnv);
      // The default-constructed service has a real Databases instance; we
      // only assert that the accessor exists and returns something with the
      // methods the bootstrap script needs.
      const db = svc.databases;
      expect(typeof db.get).toBe('function');
      expect(typeof db.createCollection).toBe('function');
      expect(typeof db.createStringAttribute).toBe('function');
      expect(typeof db.createIndex).toBe('function');
    });
  });
});
