// Dev-only fallback HMAC secret for the QUERYPRISM-EMBEDDED-SIGN envelope
// (§109/§121). SINGLE SOURCE OF TRUTH — previously the literal was
// copy-pasted in configuration.ts, embedded-sign.service.ts,
// scripts/sign-embedded.ts, and assistant.e2e-spec.ts with nothing keeping
// them in sync (2026-09 review P0-5). Production MUST set EMBEDDED_SIGN_SECRET
// and never rely on this value.
export const EMBEDDED_SIGN_DEV_SECRET =
  'queryprism-embedded-sign-secret-change-me';
