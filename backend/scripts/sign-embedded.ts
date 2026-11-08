#!/usr/bin/env node
// sign-embedded — dev/reference tool (§121 gap #3, Phase 11G cycle 2).
//
// Builds a QUERYPRISM-EMBEDDED-SIGN envelope for testing
// GET /api/v1/system/assistant/info/:id. NOT a production browser SDK — see
// backend/src/assistant/EMBEDDED_SIGN.md (the global EMBEDDED_SIGN_SECRET must
// NOT ship in a browser bundle; the 6 payload-constraint checks (3-8) are the
// real defense, not the HMAC).
//
// Usage (from backend/):
//   pnpm run sign:embedded -- --assistant-id 1 --target https://embed.example.com --timezone Asia/Shanghai
//   # or directly:
//   node -r ts-node/register scripts/sign-embedded.ts --assistant-id 1 --target ... --timezone ...
//
// Then call the bootstrap route:
//   SIGN=$(pnpm run sign:embedded --silent -- --assistant-id 1 --target https://embed.example.com --timezone Asia/Shanghai --user-agent 'Mozilla/5.0 test')
//   curl -H "QUERYPRISM-EMBEDDED-SIGN: $SIGN" -H "User-Agent: Mozilla/5.0 test" \
//        "http://localhost:3000/api/v1/system/assistant/info/1?virtual=999"
//
// The sign payload has exactly 6 fields (assistant_id/target/sign_time/webdriver
// /user_agent/timezone). sign_time = now; webdriver = false. `virtual` is NOT a
// sign field (it's a bootstrap ?virtual= query param + JWT id claim) — pass it
// on the bootstrap URL, not here.
import { signEnvelope, type SignPayload } from '../src/assistant/embedded-sign.service';
import { EMBEDDED_SIGN_DEV_SECRET } from '../src/common/constants/embedded-sign-dev-secret';
import { parseStrictInt } from '../src/common/utils/parse-int';

interface CliArgs {
  assistantId: number;
  target: string;
  timezone: string;
  userAgent: string;
}

function usage(): never {
  console.error(`Usage: sign-embedded --assistant-id <n> --target <url> --timezone <IANA> [--user-agent <ua>]

Required:
  --assistant-id <n>   The assistant's DB id.
  --target <url>        The embedding page origin (must match the assistant's domain whitelist).
  --timezone <IANA>     The browser's IANA zone (e.g. Asia/Shanghai, UTC).

Optional:
  --user-agent <ua>     The User-Agent to sign (MUST match the request's User-Agent header).
                       Defaults to 'sign-cli/1.0'.

Env:
  EMBEDDED_SIGN_SECRET  The HMAC key (must match the server's). Falls back to the
                       dev default + warns if unset.

Prints the envelope to stdout (no trailing newline).`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) usage();
  const assistantIdStr = get('--assistant-id');
  const target = get('--target');
  const timezone = get('--timezone');
  const userAgent = get('--user-agent') ?? 'sign-cli/1.0';
  if (!assistantIdStr || !target || !timezone) usage();
  // P2-1: strict parse — Number() only guarded NaN, so 1.5/-1/0x10 were
  // happily signed as assistant ids.
  const assistantId = parseStrictInt(assistantIdStr);
  if (assistantId === null) usage();
  return { assistantId, target, timezone, userAgent };
}

function main(): void {
  const { assistantId, target, timezone, userAgent } = parseArgs(process.argv.slice(2));
  const secret = process.env.EMBEDDED_SIGN_SECRET;
  if (!secret) {
    console.error(
      'warning: EMBEDDED_SIGN_SECRET not set — using dev default. Do NOT use in production.',
    );
  }
  const effectiveSecret = secret ?? EMBEDDED_SIGN_DEV_SECRET;
  const payload: SignPayload = {
    assistant_id: assistantId,
    target,
    sign_time: new Date().toISOString(),
    webdriver: false,
    user_agent: userAgent,
    timezone,
  };
  process.stdout.write(signEnvelope(payload, effectiveSecret));
}

main();
