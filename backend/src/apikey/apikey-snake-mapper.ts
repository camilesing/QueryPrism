// apikey-snake-mapper — Phase 10c cycle 1 §82/§88/§99. Maps an ApiKey row to
// the snake_case shape the frontend reads (ApikeyGridItem). Applied in the
// SERVICE (ApiKeyService.findAll), not the controller.
//
// Three contract-specific behaviors:
//   - `secret_key` is MASKED on the list ('' — 2026-09 review P0-2). The
//     plaintext is only served by the reveal-on-demand route
//     (GET /system/apikey/:id/secret, ApiKeyService.revealSecret); the
//     frontend's show/copy actions fetch it per row. The mapper is a
//     pure function over the row it receives (the caller decides masking).
//   - `status` is Boolean on the wire (el-switch `:active-value="true"`) and
//     stored as Boolean in the DB. The mapper passes it through.
//   - `create_time` is a NUMERIC epoch-ms timestamp. The frontend sorts
//     `a.create_time - b.create_time` numerically + formats via
//     `formatTimestamp(scope.row.create_time, ...)` which does `new Date(ts)`
//     → JS Date interprets a number as epoch MS. The mapper converts
//     `createdAt: Date` → `create_time: number` via `getTime()`.
//
// The frontend reads NO `remark` / `updated_time` / `has_secret` — those are
// omitted (the migration dropped `remark`/`updatedAt` from the schema).
export interface ApiKeyRow {
  id: number;
  accessKey: string;
  /** The service pre-decrypts the at-rest ciphertext before calling this
   *  mapper — or passes '' when the caller wants the list MASKED (review
   *  P0-2; plaintext only via revealSecret). */
  secretKey: string;
  status: boolean;
  createdAt: Date;
}

export interface ApiKeySnake {
  id: number;
  access_key: string;
  /** Plaintext when revealed on demand; '' on the masked list. */
  secret_key: string;
  status: boolean;
  /** Epoch-ms timestamp (numeric, for client-side sort + formatTimestamp). */
  create_time: number;
}

/** Map an ApiKey row (with service-pre-decrypted secretKey) to the
 *  snake_case list/get shape. */
export function toApiKeySnake(row: ApiKeyRow): ApiKeySnake {
  return {
    id: row.id,
    access_key: row.accessKey,
    secret_key: row.secretKey,
    status: row.status,
    create_time: row.createdAt.getTime(),
  };
}
