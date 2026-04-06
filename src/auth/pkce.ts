import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) helpers used by `AuthService` to drive the X OAuth2
 * Authorization Code flow.
 *
 * All three exports are pure functions: no NestJS, no env, no I/O. They are
 * imported directly by `AuthService` and unit-tested in isolation.
 *
 * Generation lengths:
 *   - state: 32 bytes of entropy → ~43 base64url chars (well above the 16
 *     bytes recommended by OAuth2 §10.10).
 *   - code_verifier: 48 bytes of entropy → 64 base64url chars (sits in the
 *     RFC 7636 [43, 128] range, with comfortable headroom).
 *
 * `code_challenge` is always derived as `base64url(SHA-256(verifier))`,
 * matching `code_challenge_method=S256`.
 */

/**
 * Convert a Buffer to RFC 7636 §3 base64url:
 *   `+` → `-`, `/` → `_`, strip `=` padding.
 */
function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a fresh OAuth2 `state` parameter. The value is opaque to X — it
 * only needs to be unguessable and round-trip back to us through the
 * authorize URL → callback redirect.
 */
export function generateState(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * Generate a fresh PKCE `code_verifier`. RFC 7636 requires 43–128
 * URL-safe characters; 48 random bytes encode to exactly 64 base64url
 * characters which sits comfortably inside that range.
 */
export function generateCodeVerifier(): string {
  return toBase64Url(randomBytes(48));
}

/**
 * Derive the PKCE `code_challenge` for a given verifier using S256:
 * `base64url(SHA-256(verifier))`.
 *
 * Pure function — does NOT generate randomness. Tests can pin a verifier
 * and assert exact equality, including against the RFC 7636 Appendix B
 * test vector.
 */
export function deriveCodeChallenge(verifier: string): string {
  // RFC 7636 §4.2 specifies ASCII encoding of the verifier prior to
  // hashing. Our verifier alphabet is already pure ASCII (URL-safe
  // base64), so this is a no-op for our generated values, but we set the
  // encoding explicitly so callers passing arbitrary strings get
  // deterministic behavior.
  const hash = createHash('sha256').update(verifier, 'ascii').digest();
  return toBase64Url(hash);
}
