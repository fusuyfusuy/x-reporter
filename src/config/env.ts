import { z } from 'zod';

/**
 * The full env schema for x-reporter.
 *
 * Many fields are optional in the v0.1.0 scaffold milestone (#1) and will be
 * tightened to required as their owning milestones land:
 *   - Appwrite vars  -> required by issue #2
 *   - X OAuth vars   -> required by issue #3
 *   - Redis URL      -> required by issue #5
 *   - LLM vars       -> required by issue #9
 *   - Firecrawl vars -> required by issue #8
 *   - Crypto vars    -> required by issue #3
 *
 * The only effectively required vars in this milestone are PORT and NODE_ENV,
 * both of which have sensible defaults.
 *
 * IMPORTANT: keep the keys here in sync with `.env.example` and
 * `docs/configuration.md`.
 */
const EnvSchema = z.object({
  // ----- Server -----
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ----- Appwrite (#2) -----
  APPWRITE_ENDPOINT: z.string().url().optional(),
  APPWRITE_PROJECT_ID: z.string().min(1).optional(),
  APPWRITE_API_KEY: z.string().min(1).optional(),
  APPWRITE_DATABASE_ID: z.string().min(1).default('xreporter'),

  // ----- Redis / BullMQ (#5) -----
  REDIS_URL: z.string().url().optional(),

  // ----- X OAuth2 (#3) -----
  X_CLIENT_ID: z.string().min(1).optional(),
  X_CLIENT_SECRET: z.string().min(1).optional(),
  X_REDIRECT_URI: z.string().url().optional(),
  X_SCOPES: z.string().min(1).optional(),

  // ----- LLM (#9) -----
  LLM_PROVIDER: z.enum(['openrouter']).default('openrouter'),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).default('anthropic/claude-sonnet-4.5'),

  // ----- Article extractor (#8) -----
  EXTRACTOR: z.enum(['firecrawl']).default('firecrawl'),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),

  // ----- Crypto / sessions (#3) -----
  TOKEN_ENC_KEY: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32).optional(),

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
