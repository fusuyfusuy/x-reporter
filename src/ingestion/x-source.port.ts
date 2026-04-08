/**
 * `XSource` — the first of the four swap-points described in
 * `docs/interfaces.md`. This is the data-input seam: "where does a user's
 * likes and bookmarks come from".
 *
 * The port lives on its own file (and has no imports beyond pure types) so
 * that *anything* in the codebase can reason about a tweet-item stream
 * without dragging in X-specific adapter code, HTTP clients, zod schemas,
 * or NestJS. The default adapter is `XApiV2Source` in
 * `./x-api-v2.source.ts`; a future test fake (`XMockSource`) or an
 * alternate ingestion path (`XBrowserSource`) can land here without
 * touching callers.
 *
 * `userId` in every method is the internal Appwrite document id
 * (`users.$id`), NOT the X numeric user id. This matches the argument
 * shape that `AuthService.getValidAccessToken` consumes downstream, so
 * the `poll-x` processor in milestone #7 can pass the same value it
 * pulled from the repeatable-job's job-data into both. The adapter is
 * responsible for resolving the X numeric id itself (via `UsersRepo`).
 *
 * Shape note: this refines the RawTweet/FetchPage shape sketched in
 * `docs/interfaces.md` §1 to align with the `items` collection in
 * `docs/data-model.md`:
 *
 *   - `tweetId` (was `id`) — clearer at call sites where multiple kinds
 *     of id are in scope (userId, tweetId, cursor).
 *   - `kind` — stamped by the adapter so downstream processors never
 *     have to guess which endpoint produced an item, and so the
 *     processor in #7 can pass the value straight into the `items.kind`
 *     enum.
 *   - `createdAt` dropped — the `items` collection does not persist the
 *     tweet's original creation time (only `fetchedAt`), so reading it
 *     off the X response would be wasted work for v1.
 *   - `items` (was `tweets`) — mirrors the collection name.
 *
 * The refined shape is documented in `docs/specs/x-source.md` and
 * mirrored back into `docs/interfaces.md` in the same PR.
 */

/**
 * Which X endpoint a `TweetItem` was sourced from. Matches the `items.kind`
 * enum in `docs/data-model.md` so the poll-x processor (#7) can pass the
 * value straight through into the Appwrite write.
 */
export type TweetKind = 'like' | 'bookmark';

/**
 * A single tweet (liked or bookmarked) normalized into the shape the rest
 * of the system consumes. No X-specific types or SDK envelopes leak past
 * this boundary.
 */
export interface TweetItem {
  /** X tweet snowflake id. Unique within a user when combined with `kind`. */
  tweetId: string;
  /** Raw tweet text, exactly as returned by the X API. */
  text: string;
  /**
   * X handle of the tweet's author without the leading `@`. Falls back to
   * the empty string if the adapter cannot resolve the author from the X
   * response's `includes.users[]` list — the processor in #7 persists an
   * empty string rather than failing the job, so a missing handle never
   * blocks ingestion.
   */
  authorHandle: string;
  /**
   * Expanded URLs pulled from the tweet, with `t.co` wrappers stripped,
   * deduped case-insensitively, and sorted alphabetically by lowercased
   * value for determinism. An empty array means the tweet has no URLs —
   * the processor in #7 uses that as the signal to skip enqueuing an
   * `extract-item` job for this tweet.
   */
  urls: string[];
  /** Which endpoint this item came from. */
  kind: TweetKind;
}

/**
 * One page of results plus the pagination cursor, if any. Callers pass
 * `nextCursor` back into the next `fetch*` call to continue walking
 * history; a page with `nextCursor === undefined` marks the end.
 */
export interface FetchPage {
  items: TweetItem[];
  /**
   * Opaque cursor (X's `pagination_token`) for the next page. Absent when
   * the response had no `meta.next_token`, which signals the end of
   * available history.
   */
  nextCursor?: string;
}

/**
 * The ingestion seam. Implementations fetch at most one page per call;
 * the caller (poll-x processor in #7) is responsible for deciding whether
 * to walk multiple pages within a single job.
 */
export interface XSource {
  /** Fetch at most one page of liked tweets for `userId`. */
  fetchLikes(userId: string, cursor?: string): Promise<FetchPage>;
  /** Fetch at most one page of bookmarked tweets for `userId`. */
  fetchBookmarks(userId: string, cursor?: string): Promise<FetchPage>;
}
