import { z } from 'zod';
import type { ArticleExtractor, ExtractedArticle } from './article-extractor.port';

/**
 * Default `ArticleExtractor` adapter, backed by Firecrawl's
 * `/v1/scrape` endpoint with `formats: ['markdown']`.
 *
 * No Firecrawl SDK types leak past this file; the adapter validates
 * the raw JSON response with a zod schema and maps into the
 * `ExtractedArticle` shape declared in the port.
 *
 * Per-URL content is capped at {@link ARTICLE_CONTENT_MAX_CHARS}
 * characters. The cap matches the `data-model.md` note ("Per-URL char
 * cap: 50k") and prevents an unusually large page from blowing the
 * Appwrite `articles.content` attribute size.
 */

// ────────────────────────────────────────────────────────────────────────────
// Public constants
// ────────────────────────────────────────────────────────────────────────────

/** Identifier stamped on every `ExtractedArticle` produced by this adapter. */
export const FIRECRAWL_EXTRACTOR_ID = 'firecrawl';

/** Default Firecrawl SaaS base URL. Can be overridden via env for self-hosted. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev';

/** Per-request network timeout, including body consumption. */
export const FIRECRAWL_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Hard cap on `content` length. Larger articles are truncated with a
 * trailing ellipsis marker. Matches the spec in `docs/interfaces.md`.
 */
export const ARTICLE_CONTENT_MAX_CHARS = 50_000;

// ────────────────────────────────────────────────────────────────────────────
// Config + zod schema
// ────────────────────────────────────────────────────────────────────────────

export interface FirecrawlExtractorConfig {
  /** API key from the Firecrawl dashboard (or self-host). */
  apiKey: string;
  /** Base URL; default {@link FIRECRAWL_DEFAULT_BASE_URL}. No trailing slash. */
  baseUrl?: string;
  /** Optional per-request timeout. Default {@link FIRECRAWL_DEFAULT_TIMEOUT_MS}. */
  fetchTimeoutMs?: number;
}

/**
 * Strict-ish zod schema for the Firecrawl `/v1/scrape` response. Only
 * `success` and `data.markdown` are required — every metadata field
 * the extractor surfaces (`canonicalUrl`, `title`, etc.) is optional
 * because Firecrawl can omit them on pages that don't expose the
 * corresponding signal.
 *
 * `passthrough()` is used to let future Firecrawl additions land
 * without breaking this schema; we only read the fields we care about.
 */
const ScrapeMetadataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    sourceURL: z.string().optional(),
    canonicalUrl: z.string().optional(),
    // Some Firecrawl responses use `ogSiteName` / `siteName` interchangeably.
    siteName: z.string().optional(),
    ogSiteName: z.string().optional(),
  })
  .passthrough();

const ScrapeResponseSchema = z
  .object({
    success: z.boolean(),
    data: z
      .object({
        markdown: z.string(),
        metadata: ScrapeMetadataSchema.optional(),
      })
      .passthrough()
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

// ────────────────────────────────────────────────────────────────────────────
// Adapter
// ────────────────────────────────────────────────────────────────────────────

/** Maximum number of response-body characters included in a thrown error. */
const ERROR_BODY_MAX_CHARS = 200;

export class FirecrawlExtractor implements ArticleExtractor {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FirecrawlExtractorConfig, fetchImpl: typeof fetch = fetch) {
    if (!config.apiKey) {
      throw new Error('FirecrawlExtractor: apiKey is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? FIRECRAWL_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? FIRECRAWL_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  async extract(url: string): Promise<ExtractedArticle> {
    if (!url || !url.trim()) {
      throw new Error('FirecrawlExtractor.extract called with empty url');
    }

    const endpoint = `${this.baseUrl}/v1/scrape`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    let rawJson: unknown;
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Redact the bearer token before echoing the body — defense in
        // depth against a misbehaving upstream that might reflect it.
        const rawText = await res.text().catch(() => '');
        const safeText = rawText.replaceAll(this.apiKey, '[redacted]');
        throw new Error(
          `firecrawl /v1/scrape failed: ${res.status} ${truncateForError(safeText)}`,
        );
      }
      rawJson = (await res.json()) as unknown;
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `firecrawl /v1/scrape timed out after ${this.fetchTimeoutMs}ms for ${url}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const parsed = ScrapeResponseSchema.parse(rawJson);
    if (!parsed.success || !parsed.data) {
      throw new Error(
        `firecrawl /v1/scrape returned success=false for ${url}: ${parsed.error ?? 'unknown error'}`,
      );
    }

    const metadata = parsed.data.metadata;
    const content = truncateContent(parsed.data.markdown);

    const article: ExtractedArticle = {
      url,
      content,
      extractor: FIRECRAWL_EXTRACTOR_ID,
    };
    const canonicalUrl = metadata?.canonicalUrl ?? metadata?.sourceURL;
    if (canonicalUrl && canonicalUrl !== url) {
      article.canonicalUrl = canonicalUrl;
    }
    if (metadata?.title) article.title = metadata.title;
    if (metadata?.author) article.byline = metadata.author;
    const siteName = metadata?.siteName ?? metadata?.ogSiteName;
    if (siteName) article.siteName = siteName;

    return article;
  }
}

function truncateContent(body: string): string {
  if (body.length <= ARTICLE_CONTENT_MAX_CHARS) return body;
  return `${body.slice(0, ARTICLE_CONTENT_MAX_CHARS - 1)}…`;
}

function truncateForError(body: string): string {
  if (body.length <= ERROR_BODY_MAX_CHARS) return body;
  return `${body.slice(0, ERROR_BODY_MAX_CHARS)}…[truncated]`;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}
