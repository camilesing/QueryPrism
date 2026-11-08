# Embedded Sign

The embedded-assistant bootstrap route `GET /api/v1/system/assistant/info/:id`
verifies a `QUERYPRISM-EMBEDDED-SIGN` header before issuing an assistant JWT. This
doc describes the envelope format + the security model.

## Envelope format

```
<base64url(json)>.<base64url(hmac-sha256(EMBEDDED_SIGN_SECRET, base64url(json)))>
```

The JSON payload has exactly 6 fields (the server-side verify contract):

| field         | type             | notes                                                |
| ------------- | ---------------- | ---------------------------------------------------- |
| `assistant_id`| number \| string | must match the `:id` path param                      |
| `target`      | string           | the embedding page origin; must match the assistant's `domain` whitelist (exact, trailing-slash stripped, `[,;]`-split) |
| `sign_time`   | string           | ISO 8601 with explicit offset; ±10s skew allowed     |
| `webdriver`   | boolean          | must be `false`                                      |
| `user_agent`  | string           | must exactly equal the request's `User-Agent` header |
| `timezone`    | string           | IANA zone name; its offset at `sign_time` must match the offset in `sign_time` |

The server (`backend/src/assistant/embedded-sign.service.ts`) runs 8 checks
on this payload. Any failure → `401 invalid_origin`.

## Building a sign (dev/reference)

- **Shared util** — `signEnvelope(payload, secret)` (exported from
  `embedded-sign.service.ts`) is the inverse of `verifySign`. It is pure +
  standalone (no DI). The e2e fixture + the dev CLI both delegate to it, so
  sign/verify parity is self-proving (the round-trip test in
  `embedded-sign.service.spec.ts` is the parity evidence).

- **Dev CLI** — `backend/scripts/sign-embedded.ts`:
  ```bash
  cd backend
  pnpm run sign:embedded -- --assistant-id 1 \
    --target https://embed.example.com --timezone UTC --user-agent 'jest/smoke'
  ```
  Reads `EMBEDDED_SIGN_SECRET` from env. Prints the envelope to stdout.

## ⚠️ Security caveat — NOT a production browser SDK

`signEnvelope` + the CLI are **dev/reference tools**, not a production browser
SDK. The fundamental constraint:

> The global `EMBEDDED_SIGN_SECRET` **MUST NOT** be shipped in a production
> browser bundle.

QueryPrism is open-source. Anyone can extract a secret from a browser bundle
and forge valid-looking signs.

**The 6 payload-constraint checks (3-8) are the real defense**, not the HMAC (check 2):
1. `assistant_id` match
2. `target` (origin) must be in the assistant's domain whitelist
3. ±10s skew on `sign_time`
4. `webdriver === false`
5. `user_agent` exact match
6. timezone-offset consistency

These constrain a forged sign to a narrow window (the attacker must know the
assistant id + a whitelisted origin + the victim's exact UA + timezone + act
within 10s). Still, a leaked secret + these constraints is weaker than a
secret never shipped.

**Production integrators** should run a **server-side signing proxy**: the
embedded client calls your own backend, which attests the client environment
(origin/UA/timezone) it can verify, then calls `signEnvelope` with the server-
held `EMBEDDED_SIGN_SECRET` and returns the envelope to the client for the
bootstrap call. The secret never leaves the server.

## Design note

The sign envelope is an HMAC-SHA256 scheme defined by this project; the
**server-side verify contract** (6 fields + 8 checks) is what embedded pages
must satisfy. The AssistantTokenGuard half (verifying `Assistant <jwt>` /
`Embedded <jwt>` tokens) is implemented in
`backend/src/auth/assistant-token.guard.ts`.
