/**
 * Pure URL extractor for tweets fetched from X API v2.
 *
 * Intentionally has zero NestJS / DI / external-library imports — it is
 * called from `XApiV2Source` on every tweet and must remain trivially
 * unit-testable. The only consumer is `src/ingestion/`; if a future
 * adapter needs different URL semantics it gets its own extractor.
 *
 * Two extraction paths:
 *
 *   1. **entities.urls present** — X has already parsed the tweet text
 *      and materialized expanded URLs under `entities.urls[]`. We use
 *      that list verbatim (after filtering t.co wrappers) and skip the
 *      text regex entirely. Mixing the two branches would double-count
 *      every URL X already extracted.
 *   2. **text fallback** — no entities present (or an empty array),
 *      scan `tweet.text` with a regex for anything shaped like an
 *      http(s) URL.
 *
 * In both branches the output is:
 *   - filtered of `t.co` wrappers (hostname check, not a substring match,
 *     so a real site like `t.company` is never mistaken for a wrapper);
 *   - deduped case-insensitively (keeping the first spelling we saw);
 *   - sorted alphabetically by the lowercased value for determinism in
 *     tests and downstream diffs.
 */

export interface EntityUrl {
  /** The wrapped `t.co` short URL as it appears in the tweet text. */
  url?: string;
  /** The expanded destination URL. Occasionally absent in X responses. */
  expanded_url?: string;
}

export interface TweetForExtraction {
  text: string;
  entities?: { urls?: EntityUrl[] };
}

/**
 * Match http(s) URLs in free text. Intentionally conservative:
 *   - must start with `http://` or `https://`
 *   - greedy non-whitespace body (allows dots, slashes, query/fragment)
 *   - the trailing-punctuation trim happens in a post-step, not in the
 *     regex itself, so interior `.` (e.g. `example.com`) survives.
 *
 * Parens-inside-URLs is not handled (Wikipedia URLs can contain them);
 * the tradeoff accepted here is that the handful of parens URLs in
 * liked tweets will lose their trailing `)`, which is fine for a
 * v1 reading-list digest. If it ever matters, switch to a proper
 * URL tokenizer.
 */
const URL_TEXT_REGEX = /https?:\/\/[^\s<>"'()]+/gi;

/**
 * Characters stripped from the tail of a text-matched URL. Kept separate
 * from the regex so "see https://example.com, cool" yields
 * `https://example.com` (dot/comma trimmed) but "https://example.com/a.b"
 * (dot *inside* the path) is left alone.
 */
const TRAILING_PUNCT_REGEX = /[,.;:!?]+$/;

/**
 * Host used by X's URL wrapper service. We filter any URL whose hostname
 * equals this exactly — `new URL(u).hostname === 't.co'` — so we never
 * accidentally filter something like `t.company` or `foo.t.co.evil.com`.
 */
const TCO_HOSTNAME = 't.co';

/**
 * Extract a clean, deduped, sorted list of expanded URLs from a tweet.
 * See module doc for the two-path logic and the normalization rules.
 */
export function extractUrls(tweet: TweetForExtraction): string[] {
  const collected: string[] = [];
  const entityList = tweet.entities?.urls;
  if (entityList && entityList.length > 0) {
    // Entities path: trust X's own extraction. Prefer expanded_url;
    // fall back to the raw `url` field only if no expansion is present
    // (the zod schema upstream allows expanded_url to be absent because
    // X has historically been inconsistent).
    for (const entry of entityList) {
      const candidate = entry.expanded_url ?? entry.url;
      if (candidate) collected.push(candidate);
    }
  } else {
    // Text-fallback path: regex-scan the tweet body. No entities means
    // the adapter is dealing with a response shape where X didn't pre-
    // parse the URLs (or returned an empty array), so we do it ourselves.
    // Trim trailing sentence punctuation from each match so
    // "see https://example.com, cool" surfaces `https://example.com`
    // without the stray `,`.
    const matches = tweet.text.match(URL_TEXT_REGEX);
    if (matches) {
      for (const m of matches) {
        collected.push(m.replace(TRAILING_PUNCT_REGEX, ''));
      }
    }
  }

  return normalize(collected);
}

/**
 * Shared tail of both extraction branches: drop `t.co` wrappers, dedupe
 * by lowercased value (keeping the first spelling), and sort
 * alphabetically by the lowercased value.
 */
function normalize(urls: string[]): string[] {
  // `seen` maps the lowercased key to the first spelling we saw so
  // iteration order determines tie-breaking, and `kept` preserves the
  // canonical spellings for sorting below. Keeping two structures
  // instead of one Map-of-arrays is cheaper per call and the surface
  // stays easy to read.
  const seen = new Map<string, string>();
  for (const raw of urls) {
    if (isTcoWrapper(raw)) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()].sort((a, b) => {
    const aKey = a.toLowerCase();
    const bKey = b.toLowerCase();
    if (aKey < bKey) return -1;
    if (aKey > bKey) return 1;
    return 0;
  });
}

/**
 * True iff `candidate` is a `t.co` short URL. Uses `new URL()` for the
 * hostname parse so malformed inputs (which shouldn't reach us, but
 * defense-in-depth) are treated as non-wrappers and fall through to
 * the sort step — they'll either be filtered by downstream validation
 * or surface as-is, neither of which is a correctness bug here.
 */
function isTcoWrapper(candidate: string): boolean {
  try {
    return new URL(candidate).hostname.toLowerCase() === TCO_HOSTNAME;
  } catch {
    return false;
  }
}
