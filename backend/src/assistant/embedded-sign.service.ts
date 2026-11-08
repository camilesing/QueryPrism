// EmbeddedSignService — embedded sign verification +
// assistant JWT issuance (Phase 11F).
//
// This module defines a QueryPrism HMAC-SHA256 scheme that implements the
// SERVER-SIDE verify contract: the 6 payload fields + 8 checks. The
// signed message = canonical JSON of `{assistant_id, target, sign_time,
// webdriver, user_agent, timezone}`; the envelope = `<base64url(json)>.<base64url
// (hmac-sha256(EMBEDDED_SIGN_SECRET, base64url(json)))>`.
//
// The bootstrap route `GET /system/assistant/info/:id` calls `bootstrap(...)`.
// On any check failure → `UnauthorizedException('invalid_origin')`. The
// AssistantTokenGuard half (verifying `Assistant <jwt>`/`Embedded <jwt>`
// tokens) lives in `assistant-token.guard.ts`.
import * as crypto from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { EMBEDDED_SIGN_DEV_SECRET } from '../common/constants/embedded-sign-dev-secret';
import type { SafeAssistant } from './assistant.service';

/** The 6 fields the server reads from the embedded sign. */
export interface SignPayload {
  assistant_id: number | string;
  target: string;
  sign_time: string; // ISO with explicit offset
  webdriver: boolean;
  user_agent: string;
  timezone: string; // IANA zone name
}

/** XOR-decrypt an app id. The input is the URL-safe base64 of the bytes
 *  whose int representation was XOR'd with 0xABCD1234.
 *  Pure + standalone so the AssistantTokenGuard can use it without DI. */
export function xorDecrypt(appIdBase64: string): number {
  const bytes = Buffer.from(appIdBase64, 'base64url');
  const n = parseInt(bytes.toString('hex'), 16);
  // 0xabcd1234 is a 32-bit constant — Number is safe for small ints (an
  // xor-encrypted app_id from a small id). QueryPrism type-4 appIds are UUIDs
  // (not xor-encrypted ints), so this fallback path finds no DB match → 401;
  // the primary `id` claim path handles QueryPrism-issued tokens.

  return n ^ 0xabcd1234;
}

/** Client-side sign envelope construction — the inverse of `verifySign`.
 *  Envelope = `<base64url(json)>.<base64url(hmac-sha256(secret, base64url(json)))>`,
 *  identical to what `verifySign` parses. Pure + standalone (no DI) so the e2e
 *  fixture, the dev CLI, and future integrators all build the SAME envelope the
 *  server verifies — sign/verify互逆 parity is self-proving (the round-trip
 *  test in embedded-sign.service.spec is the parity evidence).
 *
 *  SECURITY CAVEAT: this is a dev/reference tool, NOT a production
 *  browser SDK. The `secret` MUST NOT be shipped in a browser bundle (open-
 *  source = anyone can extract + forge signs). The 6 payload-constraint checks
 *  (3-8: assistant_id / origin / ±10s skew / webdriver / UA / tz-offset) are the
 *  real defense, not the HMAC (check 2). Production integrators should run a
 *  server-side signing proxy. See backend/src/assistant/EMBEDDED_SIGN.md. */
export function signEnvelope(payload: SignPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const mac = crypto
    .createHmac('sha256', secret)
    .update(b64)
    .digest('base64url');
  return `${b64}.${mac}`;
}

/** Derive the request origin from the Referer header when no Origin header
 *  is present. Returns '' when absent/unparseable (caller then rejects). */
export function getOriginFromReferer(referer: string | undefined): string {
  if (!referer) return '';
  try {
    const url = new URL(referer);
    if (!url.protocol || !url.hostname) return '';
    // Node's URL.origin is 'null' for opaque schemes (data:, blob:) — treat
    // as "no origin" the same way Python's urlparse(hostname='') path does.
    if (url.origin === 'null') return '';
    return url.origin;
  } catch {
    return '';
  }
}

@Injectable()
export class EmbeddedSignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Bootstrap route handler: load assistant (cross-workspace, active) →
   *  verify sign + run 8 checks → issue assistant JWT → return SafeAssistant
   *  + token. Throws `UnauthorizedException('invalid_origin')` on any fail. */
  async bootstrap(
    id: number,
    virtual: number | null,
    signHeader: string | undefined,
    userAgent: string,
    originHeader?: string,
    refererHeader?: string,
  ): Promise<{ assistant: SafeAssistant; token: string }> {
    const row = await this.prisma.assistant.findFirst({
      where: { id, status: 'active' },
    });
    if (!row) {
      throw new UnauthorizedException('invalid_origin');
    }
    const payload = this.verifySign(signHeader);
    // The sign's target must be reconciled against the REAL request
    // origin (Origin header, else Referer-derived). '' → runChecks rejects.
    const requestOrigin =
      originHeader || getOriginFromReferer(refererHeader) || '';
    this.runChecks(payload, id, row, userAgent, requestOrigin);
    const token = await this.issueAssistantJwt(row, virtual);
    // Strip the encrypted appSecret — every caller-facing return uses the
    // SafeAssistant shape so the secret never leaves the service.
    const { appSecret: _stripped, ...safe } = row;
    void _stripped;
    return { assistant: safe, token };
  }

  /** Combined verify + runChecks for unit testing. The route handler calls
   *  this AFTER loading the assistant row (so the row is available for the
   *  domain check). Throws on any failure. */
  verifyAndRunChecks(
    signHeader: string | undefined,
    expectedAssistantId: number,
    assistant: { domain: string | null },
    requestUserAgent: string,
    requestOrigin?: string,
  ): void {
    const payload = this.verifySign(signHeader);
    this.runChecks(
      payload,
      expectedAssistantId,
      assistant,
      requestUserAgent,
      requestOrigin,
    );
  }

  /** Issue the assistant JWT (HS256 with jwt.secret, 8-day exp inherited from
   *  the JwtModule config). Claim shape is `{id:virtual,
   *  account:'queryprism-inner-assistant', oid, assistant_id}` — the
   *  `queryprism-inner-assistant` sentinel marks the virtual inner user. */
  async issueAssistantJwt(
    assistant: { id: number; oid: number },
    virtual: number | null,
  ): Promise<string> {
    return this.jwtService.signAsync({
      id: virtual,
      account: 'queryprism-inner-assistant',
      oid: assistant.oid,
      assistant_id: assistant.id,
    });
  }

  /** Standalone XOR decrypt — delegates to the module-level function so the
   *  guard can use the SAME implementation without DI. */
  xorDecrypt(appIdBase64: string): number {
    return xorDecrypt(appIdBase64);
  }

  // --- private -----------------------------------------------------------

  private secret(): string {
    const key =
      this.config.get<string>('embeddedSign.secret') ??
      EMBEDDED_SIGN_DEV_SECRET;
    return key;
  }

  /** Verify the HMAC envelope + parse JSON. Throws on bad HMAC / malformed
   *  JSON / missing header (checks 1-2). */
  private verifySign(header: string | undefined): SignPayload {
    if (!header) {
      throw new UnauthorizedException('invalid_origin');
    }
    const dot = header.indexOf('.');
    if (dot <= 0 || dot === header.length - 1) {
      throw new UnauthorizedException('invalid_origin');
    }
    const b64 = header.slice(0, dot);
    const mac = header.slice(dot + 1);
    const expected = crypto
      .createHmac('sha256', this.secret())
      .update(b64)
      .digest('base64url');
    // Constant-time compare; length mismatch throws RangeError (caught).
    try {
      const a = Buffer.from(expected, 'base64url');
      const b = Buffer.from(mac, 'base64url');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new UnauthorizedException('invalid_origin');
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('invalid_origin');
    }
    let json: string;
    try {
      json = Buffer.from(b64, 'base64url').toString('utf8');
    } catch {
      throw new UnauthorizedException('invalid_origin');
    }
    let payload: SignPayload;
    try {
      payload = JSON.parse(json) as SignPayload;
    } catch {
      throw new UnauthorizedException('invalid_origin');
    }
    return payload;
  }

  /** Run checks 3-8 (1-2 are in verifySign). Throws on any failure. */
  private runChecks(
    payload: SignPayload,
    expectedId: number,
    assistant: { domain: string | null },
    requestUserAgent: string,
    requestOrigin?: string,
  ): void {
    // (3) assistant_id match (string-coerce — signs can carry int or str).
    if (String(payload.assistant_id) !== String(expectedId)) {
      throw new UnauthorizedException('invalid_origin');
    }
    // (4) target（来源域名）校验。When the request origin is known
    // (production always passes it — Origin header, else Referer-derived),
    // reconcile first: empty/"null" target falls back to the request origin;
    // a target that disagrees with the request origin is rejected BEFORE the
    // domain whitelist check.
    let target = payload.target ?? '';
    if (requestOrigin !== undefined) {
      const requestOriginNorm = requestOrigin.replace(/\/+$/, '');
      if (!requestOriginNorm) {
        throw new UnauthorizedException('invalid_origin');
      }
      if (!target || target === 'null') {
        target = requestOriginNorm;
      } else if (target.replace(/\/+$/, '') !== requestOriginNorm) {
        throw new UnauthorizedException('invalid_origin');
      }
    }
    // target must match the assistant's domain whitelist.
    if (!this.originMatchDomain(target, assistant.domain)) {
      throw new UnauthorizedException('invalid_origin');
    }
    // (5) ±10s skew.
    const signMs = Date.parse(payload.sign_time);
    if (Number.isNaN(signMs)) {
      throw new UnauthorizedException('invalid_origin');
    }
    if (Math.abs(Date.now() - signMs) > 10_000) {
      throw new UnauthorizedException('invalid_origin');
    }
    // (6) webdriver must be false.
    if (payload.webdriver !== false) {
      throw new UnauthorizedException('invalid_origin');
    }
    // (7) user_agent exact match.
    if (payload.user_agent !== requestUserAgent) {
      throw new UnauthorizedException('invalid_origin');
    }
    // (8) tz offset consistency: the offset claimed in sign_time must match the
    // IANA zone's actual offset at that instant — computed via
    // Intl.DateTimeFormat longOffset.
    if (!this.tzOffsetMatches(payload.sign_time, payload.timezone)) {
      throw new UnauthorizedException('invalid_origin');
    }
  }

  /** Returns false if either is empty; exact match (case-sensitive) with
   *  trailing-slash strip + trim on each domain entry; the domain field
   *  splits on [,;] (multi-URL whitelist). */
  private originMatchDomain(origin: string, domain: string | null): boolean {
    if (!origin || !domain) return false;
    const trimmedOrigin = origin.trim().replace(/\/+$/, '');
    const entries = domain
      .split(/[,;]/)
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    return entries.includes(trimmedOrigin);
  }

  /** Check 8: the offset parsed from the ISO string must equal the IANA zone's
   *  offset at the sign_time UTC instant. */
  private tzOffsetMatches(signTimeIso: string, tzName: string): boolean {
    let parsedOffsetMin: number;
    if (/[Zz]$/.test(signTimeIso)) {
      parsedOffsetMin = 0;
    } else {
      const m = signTimeIso.match(/([+-])(\d{2}):(\d{2})$/);
      if (!m) return false;
      const sign = m[1] === '+' ? 1 : -1;

      parsedOffsetMin = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    }
    const ms = Date.parse(signTimeIso);
    if (Number.isNaN(ms)) return false;
    const intlOffsetMin = this.intlZoneOffset(new Date(ms), tzName);
    if (intlOffsetMin === null) return false;
    return parsedOffsetMin === intlOffsetMin;
  }

  /** Get the IANA zone's UTC offset (in minutes) at the given instant, via
   *  Intl.DateTimeFormat `longOffset` (Node has full ICU). Returns null on
   *  unknown zone or parse failure. */
  private intlZoneOffset(date: Date, tzName: string): number | null {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        timeZoneName: 'longOffset',
      }).formatToParts(date);
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (!tzPart) return null;
      const val = tzPart.value; // 'GMT' (UTC) | 'GMT+08:00' | 'GMT-05:00'
      if (val === 'GMT') return 0;
      const m = val.match(/^GMT([+-])(\d{2}):(\d{2})$/);
      if (!m) return null;
      const sign = m[1] === '+' ? 1 : -1;
      return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    } catch {
      return null;
    }
  }
}
