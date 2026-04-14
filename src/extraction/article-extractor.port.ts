/**
 * Swap-point for article extraction.
 *
 * The port is one of the four hexagonal seams documented in
 * `docs/interfaces.md`. The shape matches the default Firecrawl
 * adapter's needs but is deliberately vendor-agnostic: `content` is
 * markdown regardless of backend, and `extractor` is a free-form
 * identifier stamped by the concrete adapter so downstream rows can be
 * traced back to the impl that produced them.
 *
 * No SDK types cross this boundary — the `FirecrawlExtractor` maps the
 * raw `/v1/scrape` response into `ExtractedArticle` before returning.
 */

/**
 * The cleaned, normalised representation of a single URL, ready to be
 * persisted as an `articles` row.
 *
 * All optional fields mirror the Appwrite `articles` collection schema
 * from `data-model.md`: they are optional at the DB layer because not
 * every upstream page exposes every signal (e.g. a blog post may not
 * declare a canonical URL or byline).
 */
export interface ExtractedArticle {
  /** The URL we were asked to extract. Always the input, verbatim. */
  url: string;
  /** Canonical URL surfaced by the extractor, if any. */
  canonicalUrl?: string;
  /** Article title. */
  title?: string;
  /** Author / byline. */
  byline?: string;
  /** Publisher / site name. */
  siteName?: string;
  /** Cleaned markdown body. Subject to a per-URL character cap. */
  content: string;
  /** Identifier for the extractor impl that produced this row, e.g. `firecrawl`. */
  extractor: string;
}

export interface ArticleExtractor {
  /**
   * Fetch the given URL and return its cleaned representation.
   *
   * Implementations should throw on non-2xx (or any unrecoverable
   * parsing error) so BullMQ retries. Per-URL failures are handled by
   * the calling processor, not the port.
   */
  extract(url: string): Promise<ExtractedArticle>;
}
