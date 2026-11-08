// apikey-snake-mapper spec — Phase 10c cycle 1 §82/§88/§99. The
// frontend (Apikey.vue:93 `state.tableData = res || []`) reads the apikey
// list as a bare array of snake_case rows:
//   - `access_key` / `secret_key` / `status` / `create_time` (ApikeyGridItem).
//   - `secret_key` is returned in PLAINTEXT — the frontend reveals it on
//     toggle (Apikey.vue:178 `scope.row.showPwd ? scope.row.secret_key : pwd`)
//     and copies the raw value (Apikey.vue:56 `copy(row['secret_key'])`). The
//     service AES-256-GCM-encrypts `secretKey` at rest (§99) and pre-decrypts
//     to plaintext before mapping; the mapper is a pure function over the row
//     it receives (no AES here — the aesKey lives on the service).
//   - `status` is Boolean on the wire (el-switch `:active-value="true"`), and
//     stored as Boolean in the DB.
//   - `create_time` is a NUMERIC epoch-ms timestamp (the frontend sorts
//     `a.create_time - b.create_time` numerically + formats via
//     `formatTimestamp(scope.row.create_time, ...)` which does `new Date(ts)`
//     → JS Date interprets a number as epoch MS). The mapper converts
//     `createdAt: Date` → `create_time: number` via `getTime()`.
import { toApiKeySnake } from './apikey-snake-mapper';

const baseRow = {
  id: 7,
  accessKey: 'ak_live_abc123',
  secretKey: 'sk_live_xyz789', // plaintext (service pre-decrypted before mapping)
  status: true,
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
};

describe('toApiKeySnake', () => {
  it('maps all fields to snake_case with plaintext secret_key + epoch-ms create_time', () => {
    const out = toApiKeySnake(baseRow);
    expect(out).toEqual({
      id: 7,
      access_key: 'ak_live_abc123',
      secret_key: 'sk_live_xyz789',
      status: true,
      create_time: baseRow.createdAt.getTime(), // epoch ms
    });
  });

  it('preserves status=false (disabled) as boolean false', () => {
    const out = toApiKeySnake({ ...baseRow, status: false });
    expect(out.status).toBe(false);
  });

  it('passes secret_key through verbatim (the mapper does NOT decrypt — service pre-decrypts)', () => {
    const plaintext = 'decrypted-secret-from-service';
    const out = toApiKeySnake({ ...baseRow, secretKey: plaintext });
    expect(out.secret_key).toBe(plaintext);
  });

  it('emits create_time as a number (epoch ms), not an ISO string or Date', () => {
    const out = toApiKeySnake(baseRow);
    expect(typeof out.create_time).toBe('number');
    expect(out.create_time).toBe(baseRow.createdAt.getTime());
  });

  it('does not emit remark / updated_time / has_secret (frontend reads none of those)', () => {
    const out = toApiKeySnake(baseRow);
    expect(out).not.toHaveProperty('remark');
    expect(out).not.toHaveProperty('updated_time');
    expect(out).not.toHaveProperty('hasSecret');
    expect(out).not.toHaveProperty('has_secret');
  });
});
