import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cookie helpers used by the auth module:
 *
 *   1. {@link signCookieValue} / {@link verifyCookieValue}
 *      HMAC-SHA256-signed JSON envelope used by the PKCE state cookie and
 *      the session cookie. Format: `base64url(json).base64url(hmac)`. The
 *      same secret (`SESSION_SECRET`) signs both.
 *
 *   2. {@link serializeCookie}
 *      Minimal `Set-Cookie` builder. Avoids pulling in `cookie` /
 *      `set-cookie-parser` etc.
 *
 *   3. {@link parseCookies}
 *      Minimal `Cookie` header parser used to read incoming cookies on the
 *      callback request. Returns a plain object map.
 *
 * Why hand-rolled instead of `@nestjs/passport` or `cookie`: this module
 * intentionally has no third-party deps so the auth surface stays
 * trivially auditable. The crypto primitives come from Node's standard
 * library and are well-trodden.
 */

// ────────────────────────────────────────────────────────────────────────────
// Sign / verify
// ────────────────────────────────────────────────────────────────────────────

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  // Buffer.from supports `base64url` directly in modern Node/Bun.
  return Buffer.from(s, 'base64url');
}

/**
 * HMAC-sign a JSON-able payload. The result is safe to put in a cookie
 * value (no separator collision with `Set-Cookie` syntax).
 */
export function signCookieValue(payload: unknown, secret: string): string {
  const json = JSON.stringify(payload);
  const payloadPart = toBase64Url(Buffer.from(json, 'utf8'));
  const hmac = createHmac('sha256', secret).update(payloadPart).digest();
  const sigPart = toBase64Url(hmac);
  return `${payloadPart}.${sigPart}`;
}

/**
 * Verify a value previously produced by {@link signCookieValue} and return
 * the parsed payload, or `null` on any failure (missing separator,
 * invalid base64url, JSON parse error, signature mismatch). NEVER throws —
 * the auth controller branches on `null` so a tampered cookie produces a
 * 400, not a 500.
 */
export function verifyCookieValue<T>(raw: string, secret: string): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const dot = raw.indexOf('.');
  if (dot < 1 || dot >= raw.length - 1) return null;

  const payloadPart = raw.slice(0, dot);
  const sigPart = raw.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  let provided: Buffer;
  try {
    provided = fromBase64Url(sigPart);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let json: string;
  try {
    json = fromBase64Url(payloadPart).toString('utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Set-Cookie serialization
// ────────────────────────────────────────────────────────────────────────────

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  /** Lifetime in seconds. Use `0` to immediately expire (clear). */
  maxAge: number;
  path: string;
  /** Optional `Domain` attribute. Most callers should leave this unset. */
  domain?: string;
}

/** Build a single `Set-Cookie` header value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(
    `SameSite=${opts.sameSite.charAt(0).toUpperCase()}${opts.sameSite.slice(1)}`,
  );
  return parts.join('; ');
}

// ────────────────────────────────────────────────────────────────────────────
// Cookie header parsing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse an incoming `Cookie` header into a `name → value` map. Returns an
 * empty object on `undefined` / empty input. Tolerant of stray whitespace
 * around the `; ` separator.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const piece of header.split(';')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
