import { z } from 'zod';
import type { UserRecord, UsersRepo } from '../users/users.repo';
import { extractUrls } from './url-extractor';
import type { FetchPage, TweetItem, TweetKind, XSource } from './x-source.port';

/**
 * Default adapter for the `XSource` port, hitting X API v2 directly via
 * Bun's native `fetch`. The only module outside `src/ingestion/` it
 * depends on is:
 *
 *   - `AuthService.getValidAccessToken` (via the `FakeAuthService`
 *     structural type below) to fetch a valid bearer token per call.
 *   - `UsersRepo.findById` to resolve the X numeric user id (which is
 *     the path parameter for `/2/users/:id/...`). Downstream callers
 *     always pass the internal Appwrite user id because that's what
 *     `getValidAccessToken` consumes — this adapter is the place that
 *     maps between the two.
 *
 * No token material is ever logged or embedded in thrown errors. On
 * non-2xx we surface status + a truncated response body; on malformed
 * JSON we surface the zod parse error as-is. In both cases the BullMQ
 * processor in milestone #7 is responsible for retry / backoff — this
 * adapter does nothing at the HTTP level beyond the per-request timeout.
 */

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

/**
 * Configuration surface for the adapter. Kept minimal: the `baseUrl` is
 * injectable so tests and a future staging environment can override it,
 * and the timeout lives here so ops can tune it without a redeploy of
 * the module wiring.
 */
export interface XApiV2SourceConfig {
  /** X API base URL, e.g. `https://api.twitter.com`. No trailing slash. */
  baseUrl: string;
  /**
   * Per-request network timeout, including body consumption. Stalls
   * beyond this bound are turned into an `Error` and bubble out so the
   * #7 processor can retry with backoff. Optional; default 10s.
   */
  fetchTimeoutMs?: number;
}

/**
 * Structural type describing the only method of `AuthService` this
 * adapter consumes. Accepting the minimal shape (rather than the full
 * class) lets tests construct a fake without standing up the whole
 * crypto/repo pipeline, and makes the dependency direction obvious:
 * "ingestion uses auth as a service, not the reverse".
 */
export interface FakeAuthService {
  getValidAccessToken(userId: string): Promise<string>;
}

// ────────────────────────────────────────────────────────────────────────────
// Zod schemas for X API v2 responses
// ────────────────────────────────────────────────────────────────────────────

/**
 * Entry shape inside `entities.urls[]`. Both fields are optional because
 * X has, in practice, been inconsistent: occasionally a tweet has `url`
 * only, or `expanded_url` only. `url-extractor` handles the fallback.
 */
const EntityUrlSchema = z
  .object({
    url: z.string().optional(),
    expanded_url: z.string().optional(),
  })
  .passthrough();

/**
 * Single tweet in `data[]`. Only `id` and `text` are required — the rest
 * are optional so a tweet with no entities / no author still parses and
 * maps cleanly to a `TweetItem` (with an empty `urls[]` and an empty
 * `authorHandle`).
 */
const TweetSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    author_id: z.string().optional(),
    entities: z
      .object({ urls: z.array(EntityUrlSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One user entry inside `includes.users[]`. */
const IncludedUserSchema = z
  .object({ id: z.string().min(1), username: z.string().min(1) })
  .passthrough();

/**
 * Full response envelope for `/2/users/:id/liked_tweets` and
 * `/2/users/:id/bookmarks`. `data` may be missing entirely when the
 * endpoint has no results for the user; normalise that to an empty
 * array downstream.
 */
const FetchPageResponseSchema = z
  .object({
    data: z.array(TweetSchema).optional(),
    includes: z
      .object({ users: z.array(IncludedUserSchema).optional() })
      .passthrough()
      .optional(),
    meta: z.object({ next_token: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()
  // A response that is literally `{}` is never legitimate from X — every
  // real call returns at least `data` or `meta`. Failing fast here keeps
  // schema drift from being silently swallowed as "empty page".
  .refine((value) => value.data !== undefined || value.meta !== undefined, {
    message: 'x api v2 response is missing both data and meta',
  });

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Default timeout for outbound X API v2 calls (10s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * `max_results` we ask X for on every page. 100 is the documented
 * maximum for both `liked_tweets` and `bookmarks`. Downstream cadence
 * is controlled by the repeatable job interval, not the page size.
 */
const MAX_RESULTS = '100';

/**
 * Shared `tweet.fields` list. The three values listed are exactly what
 * `url-extractor` and the `TweetItem` mapping consume:
 *   - `entities` → expanded URLs
 *   - `author_id` → key into `includes.users`
 *   - `text` → raw tweet body (also the regex fallback source)
 */
const TWEET_FIELDS = 'entities,author_id,text';

/**
 * We only read `username` off the included users list. Keeping this
 * terse means we pay less bandwidth and stop X from returning richer
 * user objects we have no use for in v1.
 */
const USER_FIELDS = 'username';

/** Maximum number of response-body characters included in a thrown error. */
const ERROR_BODY_MAX_CHARS = 200;

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

/**
 * The default `XSource` implementation. Constructor takes the config,
 * the auth dependency, the users repo, and (optionally) a `fetch`
 * override so tests can inject a fake without monkey-patching the
 * global.
 */
export class XApiV2Source implements XSource {
  constructor(
    private readonly config: XApiV2SourceConfig,
    private readonly auth: FakeAuthService,
    private readonly users: Pick<UsersRepo, 'findById'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchLikes(userId: string, cursor?: string): Promise<FetchPage> {
    return await this.fetchPage(userId, cursor, 'liked_tweets', 'like');
  }

  async fetchBookmarks(userId: string, cursor?: string): Promise<FetchPage> {
    return await this.fetchPage(userId, cursor, 'bookmarks', 'bookmark');
  }

  /**
   * Shared implementation for both endpoints. The only differences are
   * the URL path segment and the `kind` stamped on each mapped
   * `TweetItem`, so they thread through as arguments.
   */
  private async fetchPage(
    userId: string,
    cursor: string | undefined,
    endpoint: 'liked_tweets' | 'bookmarks',
    kind: TweetKind,
  ): Promise<FetchPage> {
    const user = await this.resolveUser(userId);
    const accessToken = await this.auth.getValidAccessToken(userId);

    const url = this.buildUrl(user.xUserId, endpoint, cursor);
    const json = await this.fetchJson(url, accessToken);
    const parsed = FetchPageResponseSchema.parse(json);

    const userMap = buildUserMap(parsed.includes?.users);
    const items: TweetItem[] = (parsed.data ?? []).map((tweet) => ({
      tweetId: tweet.id,
      text: tweet.text,
      authorHandle: tweet.author_id ? (userMap.get(tweet.author_id) ?? '') : '',
      urls: extractUrls({
        text: tweet.text,
        // Pass through entities exactly as zod parsed them. The
        // extractor is pure and doesn't care about extra fields thanks
        // to the schema's `passthrough()`.
        entities: tweet.entities,
      }),
      kind,
    }));

    return {
      items,
      ...(parsed.meta?.next_token !== undefined ? { nextCursor: parsed.meta.next_token } : {}),
    };
  }

  /**
   * Load the user row from the repo, verify the status allows polling.
   * Throws a plain `Error` with the userId in the message so a
   * misconfigured scheduled job is easy to trace in logs. Status other
   * than `active` (e.g. `paused`, `auth_expired`) is a caller-side
   * contract violation — this adapter should not have been invoked in
   * the first place — but we defend against it so the processor in #7
   * cannot silently poll a suspended account.
   */
  private async resolveUser(userId: string): Promise<UserRecord> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new Error(`XApiV2Source: user not found: ${userId}`);
    }
    if (user.status !== 'active') {
      throw new Error(`XApiV2Source: user ${userId} is not active (status=${user.status})`);
    }
    return user;
  }

  /** Construct the full request URL including all required query params. */
  private buildUrl(
    xUserId: string,
    endpoint: 'liked_tweets' | 'bookmarks',
    cursor: string | undefined,
  ): string {
    const params = new URLSearchParams({
      // `expansions=author_id` is what actually causes X to return the
      // related user objects under `includes.users`. Without it, the
      // `user.fields` request is silently ignored, `includes.users` is
      // omitted, and `authorHandle` resolves to '' for every tweet.
      expansions: 'author_id',
      'tweet.fields': TWEET_FIELDS,
      'user.fields': USER_FIELDS,
      max_results: MAX_RESULTS,
    });
    // Only add pagination_token when we actually have one — passing an
    // empty string would make X treat it as a first-page request anyway,
    // but omitting it keeps the URL clean for debugging and matches what
    // the tests assert.
    if (cursor !== undefined) {
      params.set('pagination_token', cursor);
    }
    return `${this.config.baseUrl}/2/users/${xUserId}/${endpoint}?${params.toString()}`;
  }

  /**
   * Issue the GET request, enforce the timeout, and read the JSON body.
   * Errors here fall into three buckets:
   *   1. transport failure / timeout → bubble as-is (likely retriable)
   *   2. non-2xx → throw with status + truncated body
   *   3. body parse failure → bubble as-is (body was not JSON)
   *
   * The bearer token is injected only into the `Authorization` header
   * and never appears in the thrown error messages.
   */
  private async fetchJson(url: string, accessToken: string): Promise<unknown> {
    const timeoutMs = this.config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Read the body for diagnostics. A truncated echo of the error
        // envelope makes `502 Bad Gateway` vs `429 Too Many Requests` vs
        // `401 Unauthorized` trivially distinguishable in logs without
        // any per-status ladder here. Defense in depth: if X (or an
        // intermediary) reflects the bearer back in the body, scrub it
        // before truncating so it can't leak through the thrown Error.
        const rawText = await res.text().catch(() => '');
        const safeText =
          accessToken.length > 0 ? rawText.replaceAll(accessToken, '[redacted]') : rawText;
        throw new Error(
          `x api v2 ${new URL(url).pathname} failed: ${res.status} ${truncateForError(safeText)}`,
        );
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`x api v2 request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Flatten `includes.users` into a `Map<author_id, username>`. Returning a
 * Map (instead of linear `.find()` on each tweet) matters in the common
 * case: a 100-tweet page with ~30 unique authors means 100 lookups
 * against a 30-entry map is ~O(100) instead of O(3000). Not a bottleneck
 * in practice, but the Map version is also easier to reason about.
 */
function buildUserMap(
  users: Array<{ id: string; username: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!users) return map;
  for (const u of users) map.set(u.id, u.username);
  return map;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

/**
 * Clamp an upstream response body for inclusion in an `Error` message.
 * X's v2 error envelope is small by design, but we still cap to keep a
 * rogue response from ballooning logs.
 */
function truncateForError(body: string): string {
  if (body.length <= ERROR_BODY_MAX_CHARS) return body;
  return `${body.slice(0, ERROR_BODY_MAX_CHARS)}…[truncated]`;
}
