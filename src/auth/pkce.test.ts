import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce';

/**
 * RFC 7636 §4.1: code_verifier MUST contain only the URL-safe characters
 * `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"` and have a length between
 * 43 and 128 characters.
 */
const URL_SAFE_RE = /^[A-Za-z0-9\-._~]+$/;

describe('generateState', () => {
  it('returns a non-empty URL-safe string', () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
    expect(URL_SAFE_RE.test(state)).toBe(true);
  });

  it('returns a different value on each call (random)', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });

  it('returns a value at least 32 characters long', () => {
    expect(generateState().length).toBeGreaterThanOrEqual(32);
  });
});

describe('generateCodeVerifier', () => {
  it('returns a URL-safe string', () => {
    const v = generateCodeVerifier();
    expect(URL_SAFE_RE.test(v)).toBe(true);
  });

  it('returns a value at least 43 characters long (RFC 7636 minimum)', () => {
    expect(generateCodeVerifier().length).toBeGreaterThanOrEqual(43);
  });

  it('returns a value at most 128 characters long (RFC 7636 maximum)', () => {
    expect(generateCodeVerifier().length).toBeLessThanOrEqual(128);
  });

  it('returns a different value on each call (random)', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe('deriveCodeChallenge', () => {
  it('matches base64url(SHA-256(verifier)) for a known verifier', () => {
    // RFC 7636 Appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('is a pure function (same input → same output)', () => {
    const v = 'fixed-verifier-string';
    expect(deriveCodeChallenge(v)).toBe(deriveCodeChallenge(v));
  });

  it('produces a value that recomputes from a freshly generated verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    // Recompute manually and compare.
    const expected = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('returns a URL-safe value with no padding', () => {
    const challenge = deriveCodeChallenge(generateCodeVerifier());
    expect(URL_SAFE_RE.test(challenge)).toBe(true);
    expect(challenge.includes('=')).toBe(false);
  });
});
