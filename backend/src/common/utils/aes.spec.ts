import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { decrypt, encrypt, encryptJson } from './aes';

const SECRET = 'test-secret-32-bytes-long!!';

/** Reproduce a payload exactly as the pre-rename code wrote it: the scrypt
 *  salt and the built-in key default were renamed (minichartbot→queryprism),
 *  which silently re-keyed every ciphertext written before the rename. */
function legacyEncrypt(plain: string, secret: string, salt: string): string {
  const key = scryptSync(secret, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64')).join(':');
}

describe('aes utils', () => {
  it('round-trips current payloads', () => {
    const payload = encrypt('hello', SECRET);
    expect(decrypt(payload, SECRET)).toBe('hello');
  });

  it('round-trips JSON payloads', () => {
    const payload = encryptJson({ host: 'db', port: 5432 }, SECRET);
    expect(decrypt(payload, SECRET)).toBe('{"host":"db","port":5432}');
  });

  it('still decrypts payloads written with the pre-rename salt', () => {
    const legacy = legacyEncrypt('old secret', SECRET, 'minichartbot-aes-salt');
    expect(decrypt(legacy, SECRET)).toBe('old secret');
  });

  it('still decrypts payloads written with the pre-rename default key', () => {
    // No AES_KEY env at the time: data was sealed with the old built-in key.
    const legacy = legacyEncrypt(
      'default-key secret',
      'minichartbot-aes-key-change-me-32b',
      'minichartbot-aes-salt',
    );
    expect(decrypt(legacy, 'queryprism-aes-key-change-me-32b')).toBe(
      'default-key secret',
    );
  });

  it('throws on tampered payloads, not an empty string', () => {
    const payload = encrypt('hello', SECRET);
    const parts = payload.split(':');
    const flipped = Buffer.from(parts[2], 'base64');
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], flipped.toString('base64')].join(':');
    expect(() => decrypt(tampered, SECRET)).toThrow();
  });

  it('throws on malformed payloads', () => {
    expect(() => decrypt('not-a-payload', SECRET)).toThrow(
      'Invalid encrypted payload format',
    );
  });
});
