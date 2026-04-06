import { describe, expect, it } from 'bun:test';
import { decrypt, encrypt, loadEncryptionKey } from './crypto';

/**
 * A known-good 32-byte key, base64-encoded. Used by every test that needs
 * a valid key but doesn't care about the bytes themselves.
 */
const VALID_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

describe('loadEncryptionKey', () => {
  it('returns a 32-byte Uint8Array for a valid base64 key', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('throws when the decoded key is shorter than 32 bytes', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadEncryptionKey(shortKey)).toThrow(/32 bytes/);
  });

  it('throws when the decoded key is longer than 32 bytes', () => {
    const longKey = Buffer.alloc(64, 1).toString('base64');
    expect(() => loadEncryptionKey(longKey)).toThrow(/32 bytes/);
  });

  it('throws when the input is not valid base64', () => {
    // Note: Buffer.from('...', 'base64') is permissive — it silently
    // ignores garbage chars. We use length-based validation as the
    // primary correctness gate, which is what catches typos in practice.
    expect(() => loadEncryptionKey('not-valid-base64-and-too-short')).toThrow(/32 bytes/);
  });

  it('throws on an empty string', () => {
    expect(() => loadEncryptionKey('')).toThrow(/32 bytes/);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips a plaintext string', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const plaintext = 'hello-x-oauth-token-value-12345';
    const ciphertext = encrypt(plaintext, key);
    const recovered = decrypt(ciphertext, key);
    expect(recovered).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const ciphertext = encrypt('', key);
    expect(decrypt(ciphertext, key)).toBe('');
  });

  it('round-trips multibyte unicode', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const plaintext = 'tweets 🐦 with emoji and 日本語 chars';
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
  });

  it('produces a different ciphertext on each call (random IV)', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const plaintext = 'same-plaintext';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
    // Both still decrypt back to the same plaintext.
    expect(decrypt(a, key)).toBe(plaintext);
    expect(decrypt(b, key)).toBe(plaintext);
  });

  it('emits the documented `base64(iv):base64(ciphertext+tag)` format', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const ciphertext = encrypt('payload', key);
    const parts = ciphertext.split(':');
    expect(parts.length).toBe(2);
    // 12-byte IV → base64 length 16 (no padding-strip).
    const iv = Buffer.from(parts[0]!, 'base64');
    expect(iv.length).toBe(12);
    // ciphertext+tag must be at least 16 bytes (the GCM tag alone).
    const ctTag = Buffer.from(parts[1]!, 'base64');
    expect(ctTag.length).toBeGreaterThanOrEqual(16);
  });

  it('throws when the ciphertext+tag has been tampered with', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const ciphertext = encrypt('sensitive-token', key);
    const [ivPart, ctTagPart] = ciphertext.split(':');
    const tampered = Buffer.from(ctTagPart!, 'base64');
    // Flip a bit in the middle of the ciphertext+tag blob.
    tampered[Math.floor(tampered.length / 2)] =
      (tampered[Math.floor(tampered.length / 2)]! ^ 0xff) & 0xff;
    const tamperedToken = `${ivPart}:${tampered.toString('base64')}`;
    expect(() => decrypt(tamperedToken, key)).toThrow();
  });

  it('throws when the IV has been tampered with', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    const ciphertext = encrypt('sensitive-token', key);
    const [ivPart, ctTagPart] = ciphertext.split(':');
    const tamperedIv = Buffer.from(ivPart!, 'base64');
    tamperedIv[0] = (tamperedIv[0]! ^ 0xff) & 0xff;
    const tamperedToken = `${tamperedIv.toString('base64')}:${ctTagPart}`;
    expect(() => decrypt(tamperedToken, key)).toThrow();
  });

  it('throws when decrypted with the wrong key', () => {
    const keyA = loadEncryptionKey(VALID_KEY_B64);
    const keyB = loadEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
    const ciphertext = encrypt('shh', keyA);
    expect(() => decrypt(ciphertext, keyB)).toThrow();
  });

  it('throws on a malformed token (missing colon separator)', () => {
    const key = loadEncryptionKey(VALID_KEY_B64);
    expect(() => decrypt('not-a-valid-token', key)).toThrow();
  });
});
