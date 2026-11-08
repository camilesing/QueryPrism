// EmbeddedSignService spec — TDD red for Phase 11F.
//
// The HMAC scheme is a QueryPrism-defined contract. The SERVER-SIDE verify
// contract = 6 payload fields + 8 checks. The sign envelope =
// `<base64url(json)>.<base64url(hmac-sha256(EMBEDDED_SIGN_SECRET,
// base64url(json)))>`.
//
// The 8 checks:
//  (1) sign header present
//  (2) HMAC verify + JSON parse
//  (3) String(payload.assistant_id) === String(expectedAssistantId)
//  (4) originMatchDomain(payload.target, assistant.domain) — exact match,
//      trailing-slash strip, [,;] split
//  (5) |nowUtcMs - signTimeUtcMs| <= 10_000 (10s skew)
//  (6) payload.webdriver === false
//  (7) payload.user_agent === requestUserAgent
//  (8) tz-offset consistency: Intl zone offset at signTime === parsed offset
import * as crypto from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  EmbeddedSignService,
  signEnvelope,
  getOriginFromReferer,
  type SignPayload,
} from './embedded-sign.service';
import { PrismaService } from '../database/prisma.service';

const SECRET = 'test-embedded-sign-secret';

// Delegate to the exported signEnvelope (single source of truth
// for the envelope format — sign/verify互逆 parity is self-proving).
function makeSign(payload: SignPayload): string {
  return signEnvelope(payload, SECRET);
}

function tamperMac(sign: string): string {
  const [b64, mac] = sign.split('.');
  // Flip a MIDDLE character of the mac (not the last) so the HMAC verify
  // reliably fails. The last base64url char of a 32-byte HMAC carries 2
  // "wasted" padding bits — flipping it can leave the decoded bytes unchanged
  // (~25% of runs, when the last char's high 4 bits are 0), making the tamper
  // undetected by timingSafeEqual. A middle char carries 6 meaningful bits,
  // so any flip changes the decoded bytes.
  const idx = 1;
  const ch = mac[idx];
  const sub = ch === 'A' ? 'B' : 'A';
  return `${b64}.${mac.slice(0, idx)}${sub}${mac.slice(idx + 1)}`;
}

function makeService() {
  const jwtService = {
    signAsync: jest.fn().mockResolvedValue('assistant-jwt'),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'embeddedSign.secret' ? SECRET : undefined,
    ),
  };
  const prisma = {
    assistant: { findFirst: jest.fn() },
  };
  const service = new EmbeddedSignService(
    prisma as unknown as PrismaService,
    jwtService as unknown as JwtService,
    config as unknown as ConfigService,
  );
  return { service, jwtService, config, prisma };
}

function validPayload(overrides: Partial<SignPayload> = {}): SignPayload {
  return {
    assistant_id: 42,
    target: 'https://embed.example.com',
    sign_time: new Date().toISOString(),
    webdriver: false,
    user_agent: 'Mozilla/5.0 test',
    timezone: 'UTC',
    ...overrides,
  };
}

describe('EmbeddedSignService', () => {
  describe('verifyAndRunChecks (8-check gate)', () => {
    const assistant = { id: 42, domain: 'https://embed.example.com' };

    it('valid sign → passes all 8 checks (no throw)', () => {
      const m = makeService();
      const sign = makeSign(validPayload());
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).not.toThrow();
    });

    it('check 1: missing sign header → throws', () => {
      const m = makeService();
      expect(() =>
        m.service.verifyAndRunChecks(
          undefined,
          42,
          assistant,
          'Mozilla/5.0 test',
        ),
      ).toThrow(UnauthorizedException);
    });

    it('check 2: bad HMAC → throws', () => {
      const m = makeService();
      const sign = tamperMac(makeSign(validPayload()));
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 3: assistant_id mismatch → throws', () => {
      const m = makeService();
      const sign = makeSign(validPayload({ assistant_id: 999 }));
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 4: target not in domain whitelist → throws', () => {
      const m = makeService();
      const sign = makeSign(
        validPayload({ target: 'https://evil.example.com' }),
      );
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 4 (multi-URL domain): target matches the 2nd entry → passes', () => {
      const m = makeService();
      const sign = makeSign(
        validPayload({ target: 'https://other.example.com' }),
      );
      const multi = {
        id: 42,
        domain: 'https://embed.example.com,https://other.example.com',
      };
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, multi, 'Mozilla/5.0 test'),
      ).not.toThrow();
    });

    it('check 5: expired sign_time (>10s skew) → throws', () => {
      const m = makeService();
      const old = new Date(Date.now() - 60_000).toISOString();
      const sign = makeSign(validPayload({ sign_time: old }));
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 6: webdriver true → throws', () => {
      const m = makeService();
      const sign = makeSign(validPayload({ webdriver: true }));
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 7: user_agent mismatch → throws', () => {
      const m = makeService();
      const sign = makeSign(validPayload({ user_agent: 'curl/8.0' }));
      // request UA differs from the signed UA → mismatch.
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 8: timezone offset mismatch → throws', () => {
      const m = makeService();
      // sign_time claims +00:00 (UTC) but timezone says Asia/Shanghai (+08:00).
      const sign = makeSign(
        validPayload({ timezone: 'Asia/Shanghai' }), // sign_time defaults to Z (offset 0)
      );
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).toThrow(UnauthorizedException);
    });

    it('check 8 (matched offset): timezone Asia/Shanghai + sign_time +08:00 → passes', () => {
      const m = makeService();
      // Build a sign_time whose ABSOLUTE UTC instant is ~now but claims a
      // +08:00 offset: take the Shanghai wall-clock (now + 8h) and append
      // +08:00. Date.parse(...) then resolves to now → skew ~0.
      const nowMs = Date.now();
      const shanghaiWall = new Date(nowMs + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19);
      const signTimeIso = `${shanghaiWall}+08:00`;
      const sign = makeSign(
        validPayload({
          sign_time: signTimeIso,
          timezone: 'Asia/Shanghai',
        }),
      );
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).not.toThrow();
    });
  });

  describe('origin reconciliation (2fefef0a)', () => {
    const assistant = { id: 42, domain: 'https://embed.example.com' };

    it('target matching the request origin passes', () => {
      const m = makeService();
      const sign = makeSign(validPayload());
      expect(() =>
        m.service.verifyAndRunChecks(
          sign,
          42,
          assistant,
          'Mozilla/5.0 test',
          'https://embed.example.com',
        ),
      ).not.toThrow();
    });

    it('target disagreeing with the request origin throws', () => {
      const m = makeService();
      // target is domain-whitelisted, but the REAL request came from elsewhere
      const sign = makeSign(validPayload());
      expect(() =>
        m.service.verifyAndRunChecks(
          sign,
          42,
          assistant,
          'Mozilla/5.0 test',
          'https://evil.example.com',
        ),
      ).toThrow(UnauthorizedException);
    });

    it('empty/"null" target falls back to the request origin', () => {
      const m = makeService();
      const sign = makeSign(validPayload({ target: '' }));
      expect(() =>
        m.service.verifyAndRunChecks(
          sign,
          42,
          assistant,
          'Mozilla/5.0 test',
          'https://embed.example.com',
        ),
      ).not.toThrow();
      const nullTarget = makeSign(validPayload({ target: 'null' }));
      expect(() =>
        m.service.verifyAndRunChecks(
          nullTarget,
          42,
          assistant,
          'Mozilla/5.0 test',
          'https://embed.example.com',
        ),
      ).not.toThrow();
    });

    it('empty request origin throws (Origin/Referer both absent)', () => {
      const m = makeService();
      const sign = makeSign(validPayload());
      expect(() =>
        m.service.verifyAndRunChecks(
          sign,
          42,
          assistant,
          'Mozilla/5.0 test',
          '',
        ),
      ).toThrow(UnauthorizedException);
    });

    it('getOriginFromReferer extracts the origin / rejects junk', () => {
      expect(getOriginFromReferer('https://a.example.com/x/y?z=1')).toBe(
        'https://a.example.com',
      );
      expect(getOriginFromReferer('http://a.example.com:8080/x')).toBe(
        'http://a.example.com:8080',
      );
      expect(getOriginFromReferer(undefined)).toBe('');
      expect(getOriginFromReferer('not-a-url')).toBe('');
    });
  });

  describe('issueAssistantJwt', () => {
    it('signs {id:virtual, account, oid, assistant_id} with jwt.secret', async () => {
      const m = makeService();
      const token = await m.service.issueAssistantJwt({ id: 42, oid: 1 }, 999);
      expect(token).toBe('assistant-jwt');
      expect(m.jwtService.signAsync).toHaveBeenCalledWith({
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      });
    });

    it('passes null id when virtual is null', async () => {
      const m = makeService();
      await m.service.issueAssistantJwt({ id: 42, oid: 1 }, null);
      expect(m.jwtService.signAsync).toHaveBeenCalledWith({
        id: null,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      });
    });
  });

  describe('xorDecrypt', () => {
    it('XORs the int-from-bytes with 0xABCD1234', () => {
      const m = makeService();
      // Encode the integer 42 as a 16-byte big-endian byte string, then
      // urlsafe-base64 it — the input format xorDecrypt expects.
      const buf = Buffer.alloc(16);
      buf.writeUInt32BE(42, 12);
      const b64 = buf.toString('base64url');
      const n = parseInt(buf.toString('hex'), 16);
      expect(m.service.xorDecrypt(b64)).toBe(n ^ 0xabcd1234);
    });
  });

  describe('bootstrap', () => {
    it('loads assistant by id (cross-workspace, active), verifies, issues JWT, returns SafeAssistant + token', async () => {
      const m = makeService();
      const row = {
        id: 42,
        oid: 1,
        name: 'embed-asst',
        type: 0,
        description: null,
        domain: 'https://embed.example.com',
        configuration: null,
        appId: 'uuid-42',
        appSecret: 'encrypted-secret',
        enableCustomModel: false,
        customModel: null,
        picture: null,
        ui: null,
        status: 'active',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };
      m.prisma.assistant.findFirst.mockResolvedValue(row);
      const sign = makeSign(validPayload());

      const result = await m.service.bootstrap(
        42,
        999,
        sign,
        'Mozilla/5.0 test',
        'https://embed.example.com',
      );

      expect(m.prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 42, status: 'active' },
      });
      // SafeAssistant strips appSecret
      expect(result.assistant).not.toHaveProperty('appSecret');
      expect(result.assistant.id).toBe(42);
      expect(result.assistant.name).toBe('embed-asst');
      expect(result.token).toBe('assistant-jwt');
      expect(m.jwtService.signAsync).toHaveBeenCalledWith({
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      });
    });

    it('throws when assistant not found', async () => {
      const m = makeService();
      m.prisma.assistant.findFirst.mockResolvedValue(null);
      const sign = makeSign(validPayload());
      await expect(
        m.service.bootstrap(42, 999, sign, 'Mozilla/5.0 test'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws on bad sign', async () => {
      const m = makeService();
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        domain: 'https://embed.example.com',
      });
      await expect(
        m.service.bootstrap(42, 999, 'not-a-valid-sign', 'Mozilla/5.0 test'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('signEnvelope (§121 gap #3 — client sign SDK reference impl)', () => {
    const assistant = { id: 42, domain: 'https://embed.example.com' };

    it('round-trip: signEnvelope output is accepted by verifyAndRunChecks', () => {
      const m = makeService();
      const sign = signEnvelope(validPayload(), SECRET);
      expect(() =>
        m.service.verifyAndRunChecks(sign, 42, assistant, 'Mozilla/5.0 test'),
      ).not.toThrow();
    });

    it('format: two base64url segments joined by a single dot', () => {
      const sign = signEnvelope(validPayload(), SECRET);
      expect(sign).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it('mac equals hmac-sha256(secret, b64) (§25 exact-literal)', () => {
      const sign = signEnvelope(validPayload(), SECRET);
      const [b64, mac] = sign.split('.');
      const expectedMac = crypto
        .createHmac('sha256', SECRET)
        .update(b64)
        .digest('base64url');
      expect(mac).toBe(expectedMac);
    });

    it('different secret → different mac', () => {
      const payload = validPayload();
      const a = signEnvelope(payload, SECRET);
      const b = signEnvelope(payload, 'other-secret');
      expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
    });
  });
});
