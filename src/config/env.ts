import { z } from 'zod';

/**
 * The full env schema for x-reporter.
 *
 * Several fields are still optional in this milestone and will be
 * tightened to required as their owning milestones land:
 *   - Firecrawl vars -> required by issue #8
 *
 * Required as of milestone #9 (LlmProvider):
 *   - OPENROUTER_API_KEY
 *
 * Required as of milestone #2 (Appwrite bootstrap):
 *   - APPWRITE_ENDPOINT
 *   - APPWRITE_PROJECT_ID
 *   - APPWRITE_API_KEY
 *
 * Required as of milestone #3 (X OAuth2 PKCE flow):
 *   - X_CLIENT_ID
 *   - X_CLIENT_SECRET
 *   - X_REDIRECT_URI
 *   - X_SCOPES
 *   - TOKEN_ENC_KEY (must base64-decode to exactly 32 bytes)
 *   - SESSION_SECRET (min 32 chars)
 *
 * Required as of milestone #5 (BullMQ infra + ScheduleService):
 *   - REDIS_URL (must be a valid `redis://` or `rediss://` URL;
 *     `QueueModule` and `ScheduleService` fail hard at boot otherwise)
 *
 * APPWRITE_DATABASE_ID has a default so a fresh checkout boots without
 * having to set it.
 *
 * IMPORTANT: keep the keys here in sync with `.env.example` and
 * `docs/configuration.md`.
 */
/**
 * Validate that a string is base64 that decodes to exactly 32 raw bytes.
 * Used by TOKEN_ENC_KEY so the process refuses to start with a miswired
 * key instead of silently producing unreadable ciphertext.
 */
const base64Key32 = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    {
      message: 'TOKEN_ENC_KEY must be base64 that decodes to exactly 32 bytes',
    },
  );

const EnvSchema = z.object({
  // ----- Server -----
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ----- Appwrite (#2) -----
  APPWRITE_ENDPOINT: z.string().url(),
  APPWRITE_PROJECT_ID: z.string().min(1),
  APPWRITE_API_KEY: z.string().min(1),
  APPWRITE_DATABASE_ID: z.string().min(1).default('xreporter'),

  // ----- Redis / BullMQ (#5) -----
  // Restricted to `redis://` and `rediss://` schemes so a misconfigured
  // value (e.g. an `http://` URL accidentally pasted in) fails at boot
  // rather than later as a confusing BullMQ / health-ping error.
  REDIS_URL: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === 'redis:' || protocol === 'rediss:';
        } catch {
          return false;
        }
      },
      { message: 'REDIS_URL must use the redis:// or rediss:// scheme' },
    ),

  // ----- X OAuth2 (#3) -----
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_REDIRECT_URI: z.string().url(),
  X_SCOPES: z.string().min(1),

  // ----- LLM (#9) -----
  LLM_PROVIDER: z.enum(['openrouter']).default('openrouter'),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1).default('anthropic/claude-sonnet-4.5'),

  // ----- Article extractor (#8) -----
  EXTRACTOR: z.enum(['firecrawl']).default('firecrawl'),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),

  // ----- Crypto / sessions (#3) -----
  TOKEN_ENC_KEY: base64Key32,
  SESSION_SECRET: z.string().min(32),

  // ----- Worker concurrency -----
  POLL_X_CONCURRENCY: z.coerce.number().int().positive().default(5),
  EXTRACT_ITEM_CONCURRENCY: z.coerce.number().int().positive().default(10),
  BUILD_DIGEST_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parses and validates the given environment object (defaults to `process.env`).
 * Throws a descriptive Error on validation failure so the process aborts at
 * boot before binding the HTTP server.
 */
export function loadEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
