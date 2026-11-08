// frontend-config-crypto — Phase 10 §95. AES-128-ECB/Pkcs7 crypto that is
// byte-compatible with the QueryPrism frontend's `views/ds/js/aes.ts` so the
// `configuration` field round-trips verbatim: the frontend encrypts in the
// browser, the backend stores + returns the ciphertext untouched, and decrypts
// here only when a DbConnector needs the plaintext connection params.
//
// Key is the frontend's hardcoded `QueryPrism123456` (16 bytes) — this is a
// wire-compatibility constant that ships in the frontend bundle, not a secret.
// It is intentionally SEPARATE from common/utils/aes.ts (AES-256-GCM +
// scrypt + env AES_KEY) which guards AiModel.apiKey / ApiKey.secretKey /
// Assistant.appSecret at rest. Reusing the GCM path would break the frontend
// round-trip (different algorithm, different output format, different key).
//
// Cross-compat verified 2026-07-25: crypto-js `AES.encrypt(str, WordArray,
// {mode:ECB, padding:Pkcs7}).toString()` produces base64 of the raw ciphertext
// (no salt prefix — a WordArray key skips the KDF), byte-identical to Node
// `crypto`'s `createCipheriv('aes-128-ecb', key, null)` + base64. See
// frontend-config-crypto.spec.ts for the pinned known vectors.
import { createCipheriv, createDecipheriv } from 'crypto';
import type { ConnectionConfig } from './db-connector/db-connector.interface';

const FRONTEND_KEY = 'QueryPrism123456';
const ALGORITHM = 'aes-128-ecb';
const KEY_BUFFER = Buffer.from(FRONTEND_KEY, 'utf8');

/** Encrypt a connection config to the crypto-js-compatible base64 ciphertext
 *  the frontend expects. Deterministic (ECB, no IV) — the same plaintext always
 *  yields the same ciphertext, so re-saving an unchanged config is a no-op. */
export function encryptFrontendConfig(cfg: ConnectionConfig): string {
  const cipher = createCipheriv(ALGORITHM, KEY_BUFFER, null);
  const json = JSON.stringify(cfg);
  const ciphertext = Buffer.concat([
    cipher.update(json, 'utf8'),
    cipher.final(),
  ]);
  return ciphertext.toString('base64');
}

/** Decrypt a frontend-produced ciphertext back to a ConnectionConfig. Returns
 *  `{}` for any malformed/tampered/wrong-key input — never throws — so a bad
 *  row surfaces as an empty config (connector then reports a connection
 *  failure) rather than a 500. Callers that need to distinguish "no config"
 *  from "bad config" do so via the empty-object shape. */
export function decryptFrontendConfig(
  ciphertext: string | null | undefined,
): ConnectionConfig {
  if (!ciphertext) return {};
  try {
    const decipher = createDecipheriv(ALGORITHM, KEY_BUFFER, null);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as ConnectionConfig;
  } catch {
    return {};
  }
}
