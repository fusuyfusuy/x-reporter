import { LoggerModule as PinoLoggerModule, type Params } from 'nestjs-pino';
import type { DynamicModule } from '@nestjs/common';
import type { Env } from '../config/env';

/**
 * Field-path globs that nestjs-pino / pino must redact before writing logs.
 * Anything matching these will be replaced with `[REDACTED]`.
 *
 * Add to this list whenever a new sensitive field is introduced; never log
 * raw access tokens, refresh tokens, session secrets, or PII.
 */
const REDACT_PATHS: string[] = [
  // HTTP request headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // HTTP response headers
  'res.headers["set-cookie"]',
  // Common field names anywhere in the log object
  '*.password',
  '*.passwd',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.encKey',
  '*.privateKey',
];

/**
 * Build the `Params` config object for `nestjs-pino`'s `LoggerModule.forRoot`.
 * Extracted as a pure function so it can be unit-tested without spinning up
 * the Nest container.
 */
export function buildPinoOptions(nodeEnv: Env['NODE_ENV']): Params {
  return {
    pinoHttp: {
      level: nodeEnv === 'test' ? 'silent' : nodeEnv === 'production' ? 'info' : 'debug',
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      transport:
        nodeEnv === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                singleLine: false,
              },
            }
          : undefined,
    },
  };
}

/**
 * Nest dynamic module that wires `nestjs-pino` with redaction defaults.
 * Consumers should `import { LoggerModule } from './common/logger'` and add
 * `LoggerModule.forRoot(env)` to their root module's `imports` array.
 */
export const LoggerModule = {
  forRoot(env: Env): DynamicModule {
    return PinoLoggerModule.forRoot(buildPinoOptions(env.NODE_ENV));
  },
};
