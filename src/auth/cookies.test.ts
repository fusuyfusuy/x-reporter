import { describe, expect, it } from 'bun:test';
import {
  parseCookies,
  serializeCookie,
  signCookieValue,
  verifyCookieValue,
} from './cookies';

const SECRET = 'a-test-session-secret-that-is-at-least-32-chars';

describe('signCookieValue / verifyCookieValue', () => {
  it('round-trips an arbitrary JSON-able payload', () => {
    const payload = { state: 'abc', codeVerifier: 'xyz', createdAt: 123 };
    const signed = signCookieValue(payload, SECRET);
    const recovered = verifyCookieValue<typeof payload>(signed, SECRET);
    expect(recovered).toEqual(payload);
  });

  it('returns null when the signature does not match', () => {
    const signed = signCookieValue({ userId: 'u_1' }, SECRET);
    // Mutate the signature segment by flipping the final character.
    const [payloadPart, sigPart] = signed.split('.');
    const lastChar = sigPart!.charAt(sigPart!.length - 1);
    const flipped = lastChar === 'A' ? 'B' : 'A';
    const tampered = `${payloadPart}.${sigPart!.slice(0, -1)}${flipped}`;
    expect(verifyCookieValue(tampered, SECRET)).toBeNull();
  });

  it('returns null when the payload has been tampered with', () => {
    const signed = signCookieValue({ userId: 'u_1' }, SECRET);
    // Replace the payload segment with one re-encoding a different value
    // but keep the original signature.
    const [, sigPart] = signed.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ userId: 'u_2' })).toString(
      'base64url',
    );
    expect(verifyCookieValue(`${fakePayload}.${sigPart}`, SECRET)).toBeNull();
  });

  it('returns null when verified with a different secret', () => {
    const signed = signCookieValue({ userId: 'u_1' }, SECRET);
    expect(verifyCookieValue(signed, 'a-different-secret-that-also-passes-32')).toBeNull();
  });

  it('returns null on a malformed input (no separator)', () => {
    expect(verifyCookieValue('not-a-signed-cookie', SECRET)).toBeNull();
  });

  it('returns null on a malformed payload (not base64url JSON)', () => {
    // valid signature format but garbage payload
    const signed = signCookieValue({ a: 1 }, SECRET);
    const [, sigPart] = signed.split('.');
    expect(verifyCookieValue(`!!!.${sigPart}`, SECRET)).toBeNull();
  });
});

describe('serializeCookie', () => {
  it('produces a Set-Cookie header with the basic flags', () => {
    const header = serializeCookie('xr_oauth_state', 'abc.def', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 600,
      path: '/auth/x',
    });
    expect(header).toContain('xr_oauth_state=abc.def');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=600');
    expect(header).toContain('Path=/auth/x');
    // Secure not present when secure=false.
    expect(header).not.toContain('Secure');
  });

  it('includes Secure when secure=true', () => {
    const header = serializeCookie('xr_session', 'abc', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 60,
      path: '/',
    });
    expect(header).toContain('Secure');
  });

  it('emits Max-Age=0 for cookies that should be cleared', () => {
    const header = serializeCookie('xr_oauth_state', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 0,
      path: '/auth/x',
    });
    expect(header).toContain('xr_oauth_state=');
    expect(header).toContain('Max-Age=0');
  });

  it('URL-encodes special characters in the value', () => {
    const header = serializeCookie('k', 'a;b c', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1,
      path: '/',
    });
    // ';' and ' ' must not appear unescaped inside the cookie value.
    const valuePart = header.split(';')[0]!;
    expect(valuePart.includes(' ')).toBe(false);
    expect(valuePart.includes(';')).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    const map = parseCookies('xr_oauth_state=abc.def');
    expect(map.xr_oauth_state).toBe('abc.def');
  });

  it('parses multiple cookies separated by `; `', () => {
    const map = parseCookies('xr_oauth_state=abc.def; xr_session=zzz');
    expect(map.xr_oauth_state).toBe('abc.def');
    expect(map.xr_session).toBe('zzz');
  });

  it('returns an empty object on undefined input', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('returns an empty object on empty string', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('decodes URL-encoded values', () => {
    const map = parseCookies('k=a%20b');
    expect(map.k).toBe('a b');
  });

  it('round-trips with serializeCookie', () => {
    const header = serializeCookie('xr_session', 'abc.def', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60,
      path: '/',
    });
    // The Cookie header sent by the browser is just `name=value`.
    const cookieHeader = header.split(';')[0]!;
    const map = parseCookies(cookieHeader);
    expect(map.xr_session).toBe('abc.def');
  });
});
