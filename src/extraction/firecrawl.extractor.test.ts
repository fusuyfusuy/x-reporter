import { describe, expect, it } from 'bun:test';
import {
  ARTICLE_CONTENT_MAX_CHARS,
  FIRECRAWL_EXTRACTOR_ID,
  FirecrawlExtractor,
} from './firecrawl.extractor';

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  bodyText?: string;
}

function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body =
    init.bodyText !== undefined
      ? init.bodyText
      : JSON.stringify(init.body ?? { success: true, data: { markdown: '' } });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchCall = { url: string; init?: RequestInit };

function makeFetch(responder: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const call: FetchCall = { url };
    if (init !== undefined) call.init = init;
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('FirecrawlExtractor.extract', () => {
  it('POSTs /v1/scrape with markdown format, bearer auth, and url in body', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      makeResponse({
        body: {
          success: true,
          data: {
            markdown: '# Hello',
            metadata: { title: 'Hello', author: 'alice', siteName: 'example.com' },
          },
        },
      }),
    );
    const extractor = new FirecrawlExtractor(
      { apiKey: 'test-key', baseUrl: 'https://api.firecrawl.dev' },
      fetchImpl,
    );

    const result = await extractor.extract('https://example.com/post');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.firecrawl.dev/v1/scrape');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body.url).toBe('https://example.com/post');
    expect(body.formats).toEqual(['markdown']);

    expect(result).toEqual({
      url: 'https://example.com/post',
      content: '# Hello',
      extractor: FIRECRAWL_EXTRACTOR_ID,
      title: 'Hello',
      byline: 'alice',
      siteName: 'example.com',
    });
  });

  it('stamps extractor = "firecrawl" on every result', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ body: { success: true, data: { markdown: 'hi' } } }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    const result = await extractor.extract('https://a.test');
    expect(result.extractor).toBe('firecrawl');
  });

  it('strips trailing slash from custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      makeResponse({ body: { success: true, data: { markdown: 'hi' } } }),
    );
    const extractor = new FirecrawlExtractor(
      { apiKey: 'k', baseUrl: 'https://fc.example/' },
      fetchImpl,
    );
    await extractor.extract('https://a.test');
    expect(calls[0]!.url).toBe('https://fc.example/v1/scrape');
  });

  it('throws on non-2xx response, including status and redacted body', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ status: 502, bodyText: 'upstream boom (key=secret-abc)' }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'secret-abc' }, fetchImpl);
    await expect(extractor.extract('https://a.test')).rejects.toThrow(/502/);
    await expect(extractor.extract('https://a.test')).rejects.toThrow(/\[redacted\]/);
  });

  it('throws when the payload says success=false', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ body: { success: false, error: 'rate limited' } }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    await expect(extractor.extract('https://a.test')).rejects.toThrow(/success=false/);
  });

  it('throws when the payload is not valid per the schema', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ bodyText: JSON.stringify({ data: { markdown: 'hi' } }) }),
    );
    // Missing required `success` field.
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    await expect(extractor.extract('https://a.test')).rejects.toThrow();
  });

  it('truncates content longer than ARTICLE_CONTENT_MAX_CHARS', async () => {
    const oversize = 'x'.repeat(ARTICLE_CONTENT_MAX_CHARS + 500);
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ body: { success: true, data: { markdown: oversize } } }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    const result = await extractor.extract('https://a.test');
    expect(result.content.length).toBe(ARTICLE_CONTENT_MAX_CHARS);
    expect(result.content.endsWith('…')).toBe(true);
  });

  it('omits canonicalUrl when it equals the input url', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({
        body: {
          success: true,
          data: {
            markdown: 'hi',
            metadata: { sourceURL: 'https://a.test' },
          },
        },
      }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    const result = await extractor.extract('https://a.test');
    expect(result.canonicalUrl).toBeUndefined();
  });

  it('populates canonicalUrl when metadata has one different from input', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({
        body: {
          success: true,
          data: {
            markdown: 'hi',
            metadata: { canonicalUrl: 'https://canonical.test/post' },
          },
        },
      }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    const result = await extractor.extract('https://a.test/post?ref=tw');
    expect(result.canonicalUrl).toBe('https://canonical.test/post');
  });

  it('requires a non-empty apiKey', () => {
    expect(() => new FirecrawlExtractor({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('rejects an empty url argument', async () => {
    const { fetchImpl } = makeFetch(() =>
      makeResponse({ body: { success: true, data: { markdown: 'hi' } } }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    await expect(extractor.extract('')).rejects.toThrow(/empty url/);
  });

  it('rejects a whitespace-only url argument without making a network call', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      makeResponse({ body: { success: true, data: { markdown: 'hi' } } }),
    );
    const extractor = new FirecrawlExtractor({ apiKey: 'k' }, fetchImpl);
    await expect(extractor.extract('   \t\n ')).rejects.toThrow(/empty url/);
    expect(calls).toHaveLength(0);
  });
});
