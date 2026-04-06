import { describe, expect, it } from 'bun:test';
import type { Options as PinoHttpOptions } from 'pino-http';
import { buildPinoOptions, LoggerModule } from './logger';

/**
 * `Params['pinoHttp']` from nestjs-pino is a union with DestinationStream.
 * In our codebase we always pass options, so cast through `unknown` for tests.
 */
function asOptions(params: ReturnType<typeof buildPinoOptions>): PinoHttpOptions {
  return params.pinoHttp as unknown as PinoHttpOptions;
}

describe('buildPinoOptions', () => {
  it('returns redact paths covering common secret-bearing fields', () => {
    const pinoHttp = asOptions(buildPinoOptions('development'));
    const redact = pinoHttp.redact;
    expect(redact).toBeDefined();
    if (redact && typeof redact === 'object' && 'paths' in redact) {
      const list = redact.paths;
      expect(list).toContain('req.headers.authorization');
      expect(list).toContain('req.headers.cookie');
      expect(list).toContain('res.headers["set-cookie"]');
      expect(list.some((p: string) => /password/i.test(p))).toBe(true);
      expect(list.some((p: string) => /token/i.test(p))).toBe(true);
      expect(list.some((p: string) => /secret/i.test(p))).toBe(true);
      expect(redact.censor).toBe('[REDACTED]');
    } else {
      throw new Error('redact must be an object form, not a bare string array');
    }
  });

  it('uses pino-pretty transport in development', () => {
    const pinoHttp = asOptions(buildPinoOptions('development'));
    const transport = pinoHttp.transport;
    expect(transport).toBeDefined();
    expect((transport as { target: string }).target).toBe('pino-pretty');
  });

  it('uses no transport in production (raw JSON to stdout)', () => {
    const pinoHttp = asOptions(buildPinoOptions('production'));
    expect(pinoHttp.transport).toBeUndefined();
  });

  it('sets log level to silent in test', () => {
    const pinoHttp = asOptions(buildPinoOptions('test'));
    expect(pinoHttp.level).toBe('silent');
  });
});

describe('LoggerModule', () => {
  it('exposes a forRoot factory that returns a Nest dynamic module', () => {
    expect(LoggerModule).toBeDefined();
    expect(typeof LoggerModule.forRoot).toBe('function');

    const dyn = LoggerModule.forRoot({
      NODE_ENV: 'test',
      PORT: 3000,
      APPWRITE_ENDPOINT: 'https://appwrite.test/v1',
      APPWRITE_PROJECT_ID: 'proj_test',
      APPWRITE_API_KEY: 'key_test',
      APPWRITE_DATABASE_ID: 'xreporter',
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-4.5',
      EXTRACTOR: 'firecrawl',
      POLL_X_CONCURRENCY: 5,
      EXTRACT_ITEM_CONCURRENCY: 10,
      BUILD_DIGEST_CONCURRENCY: 2,
    });
    expect(dyn).toBeDefined();
    expect(dyn.module).toBeDefined();
  });
});
