import { describe, expect, it } from 'bun:test';
import { extractUrls } from './url-extractor';

describe('extractUrls — no URLs', () => {
  it('returns [] for tweet text with no URLs and no entities', () => {
    expect(extractUrls({ text: 'just some plain text, nothing to see here' })).toEqual([]);
  });

  it('returns [] when entities.urls is an empty array and text has no URLs', () => {
    expect(extractUrls({ text: 'hello world', entities: { urls: [] } })).toEqual([]);
  });

  it('returns [] when the only URL is a t.co wrapper in text', () => {
    // t.co wrappers without an expanded form are dropped entirely —
    // without an expansion we have no canonical URL to hand downstream.
    expect(extractUrls({ text: 'see this https://t.co/abc123 cool' })).toEqual([]);
  });
});

describe('extractUrls — text fallback (no entities)', () => {
  it('extracts a single URL from plain text', () => {
    expect(extractUrls({ text: 'check out https://example.com/post today' })).toEqual([
      'https://example.com/post',
    ]);
  });

  it('extracts multiple URLs from plain text, sorted alphabetically', () => {
    const result = extractUrls({
      text: 'first https://zebra.io/a and then https://apple.io/b plus https://mango.io/c',
    });
    expect(result).toEqual([
      'https://apple.io/b',
      'https://mango.io/c',
      'https://zebra.io/a',
    ]);
  });

  it('handles both http and https schemes in text', () => {
    const result = extractUrls({
      text: 'old site http://legacy.example.org and new https://modern.example.org',
    });
    expect(result).toEqual([
      'http://legacy.example.org',
      'https://modern.example.org',
    ]);
  });

  it('strips trailing punctuation from URLs in text', () => {
    // Regex captures the URL but sentence punctuation directly after
    // should not end up in the URL itself.
    const result = extractUrls({
      text: 'look at https://example.com/path, it is great!',
    });
    expect(result).toEqual(['https://example.com/path']);
  });

  it('dedupes case-insensitively in text fallback', () => {
    const result = extractUrls({
      text: 'same link https://Example.com/Page and again https://example.com/Page right?',
    });
    // First spelling encountered wins.
    expect(result).toEqual(['https://Example.com/Page']);
  });

  it('filters t.co URLs out of text even when surrounded by real URLs', () => {
    const result = extractUrls({
      text: 'real https://example.com via https://t.co/abc and https://another.io',
    });
    expect(result).toEqual([
      'https://another.io',
      'https://example.com',
    ]);
  });
});

describe('extractUrls — entities.urls precedence', () => {
  it('uses expanded_url from entities.urls and ignores the text regex branch', () => {
    const result = extractUrls({
      text: 'shortened https://t.co/abc123 reading list',
      entities: {
        urls: [{ url: 'https://t.co/abc123', expanded_url: 'https://blog.example.com/article' }],
      },
    });
    expect(result).toEqual(['https://blog.example.com/article']);
  });

  it('does NOT fall through to text regex when entities.urls has entries', () => {
    // Even if entities.urls expanded forms are all t.co (edge case), the
    // text-fallback branch should not kick in — X already did the
    // extraction, so mixing modes would double-count.
    const result = extractUrls({
      text: 'also https://example.com/from-text should NOT appear',
      entities: {
        urls: [
          { url: 'https://t.co/xyz', expanded_url: 'https://real.example.org/post' },
        ],
      },
    });
    expect(result).toEqual(['https://real.example.org/post']);
  });

  it('maps multiple entities.urls to their expanded_urls, deduped and sorted', () => {
    const result = extractUrls({
      text: 'ignored body',
      entities: {
        urls: [
          { url: 'https://t.co/a', expanded_url: 'https://zebra.io/a' },
          { url: 'https://t.co/b', expanded_url: 'https://apple.io/b' },
          { url: 'https://t.co/c', expanded_url: 'https://mango.io/c' },
        ],
      },
    });
    expect(result).toEqual([
      'https://apple.io/b',
      'https://mango.io/c',
      'https://zebra.io/a',
    ]);
  });

  it('filters out entities.urls entries whose expanded_url is itself a t.co wrapper', () => {
    const result = extractUrls({
      text: 'ignored',
      entities: {
        urls: [
          { url: 'https://t.co/a', expanded_url: 'https://t.co/wrapped' },
          { url: 'https://t.co/b', expanded_url: 'https://real.example.com' },
        ],
      },
    });
    expect(result).toEqual(['https://real.example.com']);
  });

  it('falls back to the entry `url` field when `expanded_url` is missing', () => {
    // Defensive: the zod schema allows expanded_url to be optional because
    // X has, historically, been inconsistent. If we can't get an expansion
    // and the raw `url` is not a t.co wrapper, use it.
    const result = extractUrls({
      text: 'ignored',
      entities: {
        urls: [
          { url: 'https://direct.example.com/post' }, // no expanded_url
          { url: 'https://t.co/wrapped' }, // no expansion, and t.co → filtered
        ],
      },
    });
    expect(result).toEqual(['https://direct.example.com/post']);
  });

  it('dedupes across entities.urls case-insensitively, keeping first spelling', () => {
    const result = extractUrls({
      text: 'ignored',
      entities: {
        urls: [
          { url: 'https://t.co/a', expanded_url: 'https://Example.com/Post' },
          { url: 'https://t.co/b', expanded_url: 'https://example.com/post' },
          { url: 'https://t.co/c', expanded_url: 'https://example.com/POST' },
        ],
      },
    });
    expect(result).toEqual(['https://Example.com/Post']);
  });
});

describe('extractUrls — determinism', () => {
  it('returns the same result regardless of input order', () => {
    const a = extractUrls({
      text: 'ignored',
      entities: {
        urls: [
          { url: 'https://t.co/1', expanded_url: 'https://b.example.com' },
          { url: 'https://t.co/2', expanded_url: 'https://a.example.com' },
          { url: 'https://t.co/3', expanded_url: 'https://c.example.com' },
        ],
      },
    });
    const b = extractUrls({
      text: 'ignored',
      entities: {
        urls: [
          { url: 'https://t.co/3', expanded_url: 'https://c.example.com' },
          { url: 'https://t.co/1', expanded_url: 'https://b.example.com' },
          { url: 'https://t.co/2', expanded_url: 'https://a.example.com' },
        ],
      },
    });
    expect(a).toEqual(b);
    expect(a).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });
});
