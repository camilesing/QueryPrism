# attribution fixtures

Attribution-domain test dataset — 4 CSV tables + a SQLite DDL, used by
`attribution-governance.e2e-spec.ts` / `attribution-chat.e2e-spec.ts`.
中文版见 [README_zh.md](./README_zh.md)（内容保持同步）。

- **Source**: the FlinkSQL sink DDLs under
  `/Users/camile/Work/FlinkSQL/execute-sql/归因域/v1` (that directory ships
  DDL only, no data rows). **All data is synthetic** — `generate.ts` produces
  it with a fixed seed, so re-running the script rewrites the CSVs
  byte-identically.
- **Row counts**: `dwv_utm_attribution` 200 (visit/attribution detail),
  `dwv_order_conversion_attribution` 120 (order first/last-touch conversion),
  `dwv_order_fb_attribution` is the order subset whose first touch came from
  facebook/instagram, and `sl_dm_store_referrer_utm_rt` is the per-store ×
  day × dimension rollup (`SUM(order_cnt_first) WHERE is_first='yes'` = 120,
  reconciling with the order table).

## Column renames (vs. the v1 DDL — table names unchanged)

| Original | Renamed to | Table |
|---|---|---|
| `uuid` | `visitor_uuid` | all four |
| `slt` | `biz_source` | utm detail |
| `land_url` | `landing_url` | utm detail |
| `referer_url` | `referrer_url` | utm detail |
| `user_ip` | `client_ip` | utm detail |
| `interact_day` | `interact_days` | order conversion |
| `interact_cnt` | `interact_count` | order conversion |
| `row_key` | `dim_key` | store rollup |
| `dt` | `stat_date` | store rollup |

Type mapping: `String`→TEXT, `BIGINT/INT`→INTEGER, `TIMESTAMP(3)`→TEXT
(`YYYY-MM-DD HH:MM:SS.sss`, lexicographically comparable), `BOOLEAN`→INTEGER
0/1. Amounts are in **cents** (integers). Empty values are written as `N/A`,
following the upstream `NVLBLANK_UDF` convention.

## Modeling conventions (known simplifications of the synthetic data)

- The rollup writes two rows per aggregated group: a first-touch row
  `(is_first='yes', is_last='no')` accumulates only the `*_first` measures, a
  last-touch row the `*_last` ones; the off-side measure columns are 0.
- The `sl_source_*` (Zhuge ads) fields are randomly filled for every non-
  direct visit and have no correspondence with the FB fields.
- `campaign_id/adset_id/ad_id` only carry values on visits whose source is
  facebook/instagram.

## Regenerating / manual SQLite import

```bash
cd backend
pnpm exec ts-node test/fixtures/attribution/generate.ts   # rewrites the 4 CSVs

# Manual import (e.g. to inspect the data):
cd test/fixtures/attribution
sqlite3 attr.db < schema.sql
sqlite3 attr.db ".import --csv --skip 1 dwv_utm_attribution.csv dwv_utm_attribution"
sqlite3 attr.db ".import --csv --skip 1 dwv_order_conversion_attribution.csv dwv_order_conversion_attribution"
sqlite3 attr.db ".import --csv --skip 1 dwv_order_fb_attribution.csv dwv_order_fb_attribution"
sqlite3 attr.db ".import --csv --skip 1 sl_dm_store_referrer_utm_rt.csv sl_dm_store_referrer_utm_rt"
```

The e2e specs never import manually: `buildAttributionDb()` in
`test/helpers/attribution-fixture.ts` applies the schema and inserts the rows
via better-sqlite3.
