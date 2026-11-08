// AES-256-GCM symmetric encryption for sensitive connection/model secrets.
// Payload format: "<iv(base64)>:<authTag(base64)>:<cipher(base64)>".
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT = 'queryprism-aes-salt';
// Pre-rename (MiniChartBot) scrypt salt and built-in AES_KEY default. Renaming
// them re-keyed every ciphertext written before the rename, so decrypt falls
// back to them; new payloads are always sealed with the current salt/secret.
const LEGACY_SALT = 'minichartbot-aes-salt';
const LEGACY_DEFAULT_KEY = 'minichartbot-aes-key-change-me-32b';

function deriveKey(secret: string, salt: string = SALT): Buffer {
  return scryptSync(secret, salt, 32);
}

/** Encrypt a UTF-8 string with the given secret. */
export function encrypt(plain: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64')).join(':');
}

/** Decrypt a payload produced by `encrypt`. Throws on tamper / wrong key.
 *  Payloads sealed before the QueryPrism rename (legacy salt, and legacy
 *  built-in key when no AES_KEY was set) are still accepted. */
export function decrypt(payload: string, secret: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const candidates = [
    () => deriveKey(secret),
    () => deriveKey(secret, LEGACY_SALT),
    () => deriveKey(LEGACY_DEFAULT_KEY, LEGACY_SALT),
  ];
  let lastError: unknown;
  for (const keyOf of candidates) {
    try {
      return decryptWithKey(parts, keyOf());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function decryptWithKey(parts: string[], key: Buffer): string {
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/** Convenience: encrypt a JSON-serializable object. */
export function encryptJson(value: unknown, secret: string): string {
  return encrypt(JSON.stringify(value), secret);
}

/** Convenience: decrypt a payload back to a parsed object. */
export function decryptJson<T = unknown>(payload: string, secret: string): T {
  return JSON.parse(decrypt(payload, secret)) as T;
}
