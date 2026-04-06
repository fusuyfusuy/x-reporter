import { describe, expect, it } from 'bun:test';
import { loadEnv } from './env';

describe('loadEnv', () => {
  it('returns a typed Env when minimal required vars are present', () => {
    const env = loadEnv({
      PORT: '3000',
      NODE_ENV: 'development',
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from string to number', () => {
    const env = loadEnv({ PORT: '8080', NODE_ENV: 'production' });
    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('defaults PORT to 3000 when missing', () => {
    const env = loadEnv({ NODE_ENV: 'development' });
    expect(env.PORT).toBe(3000);
  });

  it('defaults NODE_ENV to development when missing', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
  });

  it('throws a zod validation error when PORT is not a number', () => {
    expect(() => loadEnv({ PORT: 'not-a-number', NODE_ENV: 'development' })).toThrow();
  });

  it('throws when NODE_ENV is not one of the allowed values', () => {
    expect(() => loadEnv({ NODE_ENV: 'banana' })).toThrow();
  });

  it('accepts optional Appwrite vars', () => {
    const env = loadEnv({
      APPWRITE_ENDPOINT: 'https://cloud.appwrite.io/v1',
      APPWRITE_PROJECT_ID: 'proj_abc',
      APPWRITE_API_KEY: 'key_xyz',
      APPWRITE_DATABASE_ID: 'xreporter',
    });
    expect(env.APPWRITE_ENDPOINT).toBe('https://cloud.appwrite.io/v1');
    expect(env.APPWRITE_PROJECT_ID).toBe('proj_abc');
  });

  it('accepts optional Redis URL', () => {
    const env = loadEnv({ REDIS_URL: 'redis://localhost:6379' });
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('rejects an invalid REDIS_URL', () => {
    expect(() => loadEnv({ REDIS_URL: 'not a url' })).toThrow();
  });

  it('coerces worker concurrency env vars to numbers when set', () => {
    const env = loadEnv({
      POLL_X_CONCURRENCY: '7',
      EXTRACT_ITEM_CONCURRENCY: '15',
      BUILD_DIGEST_CONCURRENCY: '3',
    });
    expect(env.POLL_X_CONCURRENCY).toBe(7);
    expect(env.EXTRACT_ITEM_CONCURRENCY).toBe(15);
    expect(env.BUILD_DIGEST_CONCURRENCY).toBe(3);
  });

  it('applies default worker concurrency when not set', () => {
    const env = loadEnv({});
    expect(env.POLL_X_CONCURRENCY).toBe(5);
    expect(env.EXTRACT_ITEM_CONCURRENCY).toBe(10);
    expect(env.BUILD_DIGEST_CONCURRENCY).toBe(2);
  });
});
