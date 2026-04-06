import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption helpers used by the auth module to encrypt X OAuth
 * access/refresh tokens before persisting them to Appwrite.
 *
 * Algorithm: **AES-256-GCM**
 *   - 32-byte key, loaded once at boot via {@link loadEncryptionKey}.
 *   - Per-record random 12-byte IV.
 *   - 16-byte authentication tag.
 *
 * Storage format (matches `docs/configuration.md#token-encryption-at-rest`):
 *
 *     base64(iv) ":" base64(ciphertext + tag)
 *
 * Why a single string blob with a colon separator: Appwrite stores each
 * token as a single string attribute, so we need a self-describing format
 * that round-trips through one column without a JSON envelope. The colon
 * is safe because base64 never produces one.
 *
 * Failure modes (all of these MUST throw and never silently corrupt data):
 *   - Loading a key that does not decode to exactly 32 bytes.
 *   - Decrypting with the wrong key.
 *   - Decrypting after any byte of the iv, ciphertext, or auth tag has
 *     been mutated.
 *   - Decrypting a token that does not contain exactly one colon.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Decode the base64-encoded `TOKEN_ENC_KEY` env var into raw key bytes.
 * Throws with a clear message if the decoded length is not exactly 32
 * bytes — the process is expected to abort at boot in that case so the
 * server never starts in a half-configured state.
 */
export function loadEncryptionKey(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${buf.length})`,
    );
  }
  // Return a fresh Uint8Array view so callers cannot mutate the underlying
  // Buffer slice and accidentally corrupt other code paths sharing the same
  // memory.
  return new Uint8Array(buf);
}

/**
 * Encrypt a UTF-8 plaintext under the given key. Generates a fresh random
 * 12-byte IV per call so the same plaintext never produces the same
 * ciphertext twice.
 */
export function encrypt(plaintext: string, key: Uint8Array): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`encryption key must be ${KEY_LENGTH_BYTES} bytes`);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Concatenate ciphertext + tag so we only need to encode one blob.
  const ctTag = Buffer.concat([ciphertext, tag]);
  return `${iv.toString('base64')}:${ctTag.toString('base64')}`;
}

/**
 * Decrypt a token previously produced by {@link encrypt}. Throws on any
 * tamper, wrong key, or malformed input. Never returns garbage.
 */
export function decrypt(token: string, key: Uint8Array): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`encryption key must be ${KEY_LENGTH_BYTES} bytes`);
  }
  const parts = token.split(':');
  if (parts.length !== 2) {
    throw new Error('malformed encrypted token: expected `iv:ciphertext` format');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const ctTag = Buffer.from(parts[1]!, 'base64');
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`malformed encrypted token: iv must be ${IV_LENGTH_BYTES} bytes`);
  }
  if (ctTag.length < AUTH_TAG_LENGTH_BYTES) {
    throw new Error('malformed encrypted token: ciphertext+tag too short');
  }
  // Split ciphertext + tag back apart.
  const tagStart = ctTag.length - AUTH_TAG_LENGTH_BYTES;
  const ciphertext = ctTag.subarray(0, tagStart);
  const tag = ctTag.subarray(tagStart);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // `decipher.final()` throws "Unsupported state or unable to authenticate
  // data" on tamper. We let that bubble up to the caller; never return a
  // partially-decrypted buffer.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
