// frontend-config-crypto spec — Phase 10 §95. The QueryPrism frontend encrypts
// the datasource `configuration` in the browser before sending (views/ds/js/aes.ts):
// AES-128-ECB, Pkcs7 padding, key `QueryPrism123456` (hardcoded 16-byte), base64
// output (no salt prefix — crypto-js uses the WordArray key directly, no KDF).
// The backend must store this ciphertext verbatim, return it verbatim, and
// decrypt it with the SAME key/algorithm when the connector needs the plaintext
// connection params (check/getTablesByConf/getSchemaByConf/execSql).
//
// This is a SEPARATE crypto path from common/utils/aes.ts (AES-256-GCM with
// scrypt + env AES_KEY) — that path guards AiModel.apiKey / ApiKey.secretKey /
// Assistant.appSecret at rest. The datasource configuration wire format is a
// frontend-compatibility constant, not a secret (the key ships in the frontend
// bundle), so reusing the env-keyed GCM path would break the round-trip.
//
// Cross-compat verified 2026-07-25: Node `crypto` AES-128-ECB/Pkcs7/base64 is
// byte-identical to crypto-js with a WordArray key. The known vectors below are
// crypto-js-produced (run via frontend/node_modules/crypto-js) and pinned so
// any drift in either library surfaces here.
import {
  decryptFrontendConfig,
  encryptFrontendConfig,
} from './frontend-config-crypto';
import type { ConnectionConfig } from './db-connector/db-connector.interface';

// Known vectors (key 'QueryPrism123456', AES-128-ECB, Pkcs7, base64),
// re-pinned 2026-11-05 for the rename. Node crypto output is byte-identical to
// crypto-js with a WordArray key. Pinned so any drift in either library (or a
// key change) surfaces here.
const KNOWN_VECTOR_SINGLE = {
  plain: { db: './database/dev.db' },
  ciphertext: '4YhIlUbEa2HOqXDTsmMTCo/XVZ3Ludk0VFuXygXtwTY=',
};
const KNOWN_VECTOR_MULTI = {
  plain: {
    host: 'localhost',
    port: 3306,
    user: 'root',
    pwd: 'secret',
    db: 'mydb',
  },
  ciphertext:
    'h+Osu1otp8lY3LAeMaJ4H+TCj8fUY25HYWfPhavPGj2JpEy44v7ZjKBtlAq0OpPnQaZn97R/tIEuH0detSylyoGrAY869i2aUF5piey2sZg=',
};

describe('frontend-config-crypto', () => {
  describe('decryptFrontendConfig', () => {
    it('decrypts a crypto-js-produced ciphertext to the plain config (single field)', () => {
      const cfg = decryptFrontendConfig(KNOWN_VECTOR_SINGLE.ciphertext);
      expect(cfg).toEqual(KNOWN_VECTOR_SINGLE.plain);
    });

    it('decrypts a crypto-js-produced ciphertext to the plain config (multi field)', () => {
      const cfg = decryptFrontendConfig(KNOWN_VECTOR_MULTI.ciphertext);
      expect(cfg).toEqual(KNOWN_VECTOR_MULTI.plain);
    });

    it('round-trips an arbitrary config through encrypt then decrypt', () => {
      const plain: ConnectionConfig = {
        host: 'db.example.com',
        port: 5432,
        user: 'alice',
        pwd: 'p@ss',
        db: 'prod',
        schema: 'public',
        ssl: true,
        extra: 'arbitrary',
      };
      const ciphertext = encryptFrontendConfig(plain);
      const back = decryptFrontendConfig(ciphertext);
      expect(back).toEqual(plain);
    });

    it('returns {} for a tampered ciphertext (graceful, never throws)', () => {
      const tampered = KNOWN_VECTOR_SINGLE.ciphertext.slice(0, -2) + 'XX';
      const cfg = decryptFrontendConfig(tampered);
      expect(cfg).toEqual({});
    });

    it('returns {} for malformed base64', () => {
      expect(decryptFrontendConfig('not-base64!!!')).toEqual({});
    });

    it('returns {} for an empty string', () => {
      expect(decryptFrontendConfig('')).toEqual({});
    });

    it('returns {} for null/undefined input', () => {
      expect(decryptFrontendConfig(null)).toEqual({});
      expect(decryptFrontendConfig(undefined as unknown as string)).toEqual({});
    });

    it('returns {} when the decrypted bytes are not valid JSON', () => {
      // 32 bytes of 0x00 → AES-128-ECB decrypts to garbage (likely fails Pkcs7
      // unpad, or yields non-JSON). Either path must surface as {} not a throw.
      const garbage = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      expect(decryptFrontendConfig(garbage)).toEqual({});
    });
  });

  describe('encryptFrontendConfig', () => {
    it('produces the crypto-js-compatible ciphertext for a single-field config', () => {
      expect(encryptFrontendConfig(KNOWN_VECTOR_SINGLE.plain)).toBe(
        KNOWN_VECTOR_SINGLE.ciphertext,
      );
    });

    it('produces the crypto-js-compatible ciphertext for a multi-field config', () => {
      expect(encryptFrontendConfig(KNOWN_VECTOR_MULTI.plain)).toBe(
        KNOWN_VECTOR_MULTI.ciphertext,
      );
    });

    it('produces a base64 string with no Salted__ prefix', () => {
      const ciphertext = encryptFrontendConfig({ db: '/tmp/x.db' });
      // base64 charset
      expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
      // no crypto-js salt prefix (would start with "U2FsdGVkX18" for KDF keys)
      expect(ciphertext).not.toMatch(/^U2FsdGVk/);
    });
  });
});
