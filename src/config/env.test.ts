import { describe, expect, it } from 'bun:test';
import { loadEnv } from './env';

/**
 * A 32-byte key (all zeros) base64-encoded. Good enough for tests; never
 * use in production.
 */
const TEST_TOKEN_ENC_KEY = Buffer.alloc(32, 0).toString('base64');
const TEST_SESSION_SECRET = 'a-test-session-secret-at-least-32-chars-long';

/**
 * Minimal env with all required vars present as of milestone #3. Tests
 * spread this and override or omit as needed.
 */
const baseEnv = {
  APPWRITE_ENDPOINT: 'https://cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: 'proj_abc',
  APPWRITE_API_KEY: 'key_xyz',
  APPWRITE_DATABASE_ID: 'xreporter',
  REDIS_URL: 'redis://localhost:6379',
  X_CLIENT_ID: 'x_client_id',
  X_CLIENT_SECRET: 'x_client_secret',
  X_REDIRECT_URI: 'http://localhost:3000/auth/x/callback',
  X_SCOPES: 'tweet.read users.read offline.access',
  TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
  SESSION_SECRET: TEST_SESSION_SECRET,
};

describe('loadEnv', () => {
  it('returns a typed Env when minimal required vars are present', () => {
    const env = loadEnv({
      ...baseEnv,
      PORT: '3000',
      NODE_ENV: 'development',
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from string to number', () => {
    const env = loadEnv({ ...baseEnv, PORT: '8080', NODE_ENV: 'production' });
    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('defaults PORT to 3000 when missing', () => {
    const env = loadEnv({ ...baseEnv, NODE_ENV: 'development' });
    expect(env.PORT).toBe(3000);
  });

  it('defaults NODE_ENV to development when missing', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.NODE_ENV).toBe('development');
  });

  it('throws a zod validation error when PORT is not a number', () => {
    expect(() =>
      loadEnv({ ...baseEnv, PORT: 'not-a-number', NODE_ENV: 'development' }),
    ).toThrow();
  });

  it('throws when NODE_ENV is not one of the allowed values', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'banana' })).toThrow();
  });

  it('returns the configured Appwrite vars when present', () => {
    const env = loadEnv(baseEnv);
    expect(env.APPWRITE_ENDPOINT).toBe('https://cloud.appwrite.io/v1');
    expect(env.APPWRITE_PROJECT_ID).toBe('proj_abc');
    expect(env.APPWRITE_API_KEY).toBe('key_xyz');
    expect(env.APPWRITE_DATABASE_ID).toBe('xreporter');
  });

  it('defaults APPWRITE_DATABASE_ID to xreporter when omitted', () => {
    const { APPWRITE_DATABASE_ID: _omit, ...rest } = baseEnv;
    const env = loadEnv(rest);
    expect(env.APPWRITE_DATABASE_ID).toBe('xreporter');
  });

  it('throws when APPWRITE_ENDPOINT is missing', () => {
    const { APPWRITE_ENDPOINT: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/APPWRITE_ENDPOINT/);
  });

  it('throws when APPWRITE_PROJECT_ID is missing', () => {
    const { APPWRITE_PROJECT_ID: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/APPWRITE_PROJECT_ID/);
  });

  it('throws when APPWRITE_API_KEY is missing', () => {
    const { APPWRITE_API_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/APPWRITE_API_KEY/);
  });

  it('throws when APPWRITE_ENDPOINT is not a URL', () => {
    expect(() => loadEnv({ ...baseEnv, APPWRITE_ENDPOINT: 'not a url' })).toThrow();
  });

  it('returns the configured REDIS_URL when present', () => {
    const env = loadEnv(baseEnv);
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('throws when REDIS_URL is missing (required as of milestone #5)', () => {
    const { REDIS_URL: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/REDIS_URL/);
  });

  it('rejects an invalid REDIS_URL', () => {
    expect(() => loadEnv({ ...baseEnv, REDIS_URL: 'not a url' })).toThrow();
  });

  it('coerces worker concurrency env vars to numbers when set', () => {
    const env = loadEnv({
      ...baseEnv,
      POLL_X_CONCURRENCY: '7',
      EXTRACT_ITEM_CONCURRENCY: '15',
      BUILD_DIGEST_CONCURRENCY: '3',
    });
    expect(env.POLL_X_CONCURRENCY).toBe(7);
    expect(env.EXTRACT_ITEM_CONCURRENCY).toBe(15);
    expect(env.BUILD_DIGEST_CONCURRENCY).toBe(3);
  });

  it('applies default worker concurrency when not set', () => {
    const env = loadEnv({ ...baseEnv });
    expect(env.POLL_X_CONCURRENCY).toBe(5);
    expect(env.EXTRACT_ITEM_CONCURRENCY).toBe(10);
    expect(env.BUILD_DIGEST_CONCURRENCY).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────
  // Milestone #3: X OAuth2 + crypto + sessions become required
  // ────────────────────────────────────────────────────────────────────

  it('returns the configured X OAuth vars when present', () => {
    const env = loadEnv(baseEnv);
    expect(env.X_CLIENT_ID).toBe('x_client_id');
    expect(env.X_CLIENT_SECRET).toBe('x_client_secret');
    expect(env.X_REDIRECT_URI).toBe('http://localhost:3000/auth/x/callback');
    expect(env.X_SCOPES).toBe('tweet.read users.read offline.access');
  });

  it('throws when X_CLIENT_ID is missing', () => {
    const { X_CLIENT_ID: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/X_CLIENT_ID/);
  });

  it('throws when X_CLIENT_SECRET is missing', () => {
    const { X_CLIENT_SECRET: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/X_CLIENT_SECRET/);
  });

  it('throws when X_REDIRECT_URI is missing', () => {
    const { X_REDIRECT_URI: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/X_REDIRECT_URI/);
  });

  it('throws when X_REDIRECT_URI is not a URL', () => {
    expect(() => loadEnv({ ...baseEnv, X_REDIRECT_URI: 'not a url' })).toThrow();
  });

  it('throws when X_SCOPES is missing', () => {
    const { X_SCOPES: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/X_SCOPES/);
  });

  it('throws when TOKEN_ENC_KEY is missing', () => {
    const { TOKEN_ENC_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/TOKEN_ENC_KEY/);
  });

  it('throws when TOKEN_ENC_KEY does not decode to exactly 32 bytes', () => {
    // 16 random bytes → too short.
    const tooShort = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadEnv({ ...baseEnv, TOKEN_ENC_KEY: tooShort })).toThrow(
      /32 bytes/,
    );
    // 64 bytes → too long.
    const tooLong = Buffer.alloc(64, 2).toString('base64');
    expect(() => loadEnv({ ...baseEnv, TOKEN_ENC_KEY: tooLong })).toThrow(
      /32 bytes/,
    );
  });

  it('accepts a TOKEN_ENC_KEY that decodes to exactly 32 bytes', () => {
    const env = loadEnv(baseEnv);
    expect(env.TOKEN_ENC_KEY).toBe(TEST_TOKEN_ENC_KEY);
    // The decoded length must actually be 32.
    expect(Buffer.from(env.TOKEN_ENC_KEY, 'base64').length).toBe(32);
  });

  it('throws when SESSION_SECRET is missing', () => {
    const { SESSION_SECRET: _omit, ...rest } = baseEnv;
    expect(() => loadEnv(rest)).toThrow(/SESSION_SECRET/);
  });

  it('throws when SESSION_SECRET is shorter than 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, SESSION_SECRET: 'too-short' })).toThrow(
      /SESSION_SECRET/,
    );
  });
});
