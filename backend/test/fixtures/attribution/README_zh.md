# attribution fixtures

归因域 (attribution domain) 测试数据集 — 4 张 CSV + SQLite DDL，供
`attribution-governance.e2e-spec.ts` / `attribution-chat.e2e-spec.ts` 使用。
English version: [README.md](./README.md)（内容保持同步）。

- **来源**：`/Users/camile/Work/FlinkSQL/execute-sql/归因域/v1` 的 FlinkSQL
  sink 建表语句（该目录只有 DDL，没有数据行）。**全部数据为合成**，由
  `generate.ts` 以固定种子生成，重跑逐字节一致。
- **行数**：`dwv_utm_attribution` 200（访问/归因明细）、
  `dwv_order_conversion_attribution` 120（订单首触/末触转化）、
  `dwv_order_fb_attribution` 为订单子集（首触来自 facebook/instagram）、
  `sl_dm_store_referrer_utm_rt` 为按店铺×日期×维度聚合的汇总
  （`SUM(order_cnt_first) WHERE is_first='yes'` = 120，与订单表口径可对账）。

## 字段改名（相对 v1 DDL，表名不变）

| 原字段 | 改为 | 所在表 |
|---|---|---|
| `uuid` | `visitor_uuid` | 全部四张 |
| `slt` | `biz_source` | utm 明细 |
| `land_url` | `landing_url` | utm 明细 |
| `referer_url` | `referrer_url` | utm 明细 |
| `user_ip` | `client_ip` | utm 明细 |
| `interact_day` | `interact_days` | 订单转化 |
| `interact_cnt` | `interact_count` | 订单转化 |
| `row_key` | `dim_key` | 店铺汇总 |
| `dt` | `stat_date` | 店铺汇总 |

类型映射：`String`→TEXT，`BIGINT/INT`→INTEGER，`TIMESTAMP(3)`→TEXT
（`YYYY-MM-DD HH:MM:SS.sss`，可按字典序比较），`BOOLEAN`→INTEGER 0/1。
金额单位为**分**（整数）。空值按上游 `NVLBLANK_UDF` 惯例写 `N/A`。

## 建模约定（合成数据的已知简化）

- 汇总表每个聚合组写两行：首触行 `(is_first='yes', is_last='no')` 只累计
  `*_first` 度量，末触行反之；非本侧度量列为 0。
- `sl_source_*`（诸葛广告）字段对所有非 direct 访问随机填充，与 FB 字段无对应关系。
- `campaign_id/adset_id/ad_id` 仅在首触来源为 facebook/instagram 的访问上有值。

## 重新生成 / 手工导入 SQLite

```bash
cd backend
pnpm exec ts-node test/fixtures/attribution/generate.ts   # 重写 4 个 CSV

# 手工导入（例如检查数据）：
cd test/fixtures/attribution
sqlite3 attr.db < schema.sql
sqlite3 attr.db ".import --csv --skip 1 dwv_utm_attribution.csv dwv_utm_attribution"
sqlite3 attr.db ".import --csv --skip 1 dwv_order_conversion_attribution.csv dwv_order_conversion_attribution"
sqlite3 attr.db ".import --csv --skip 1 dwv_order_fb_attribution.csv dwv_order_fb_attribution"
sqlite3 attr.db ".import --csv --skip 1 sl_dm_store_referrer_utm_rt.csv sl_dm_store_referrer_utm_rt"
```

e2e 里不手工导入：`test/helpers/attribution-fixture.ts` 的
`buildAttributionDb()` 用 better-sqlite3 完成 schema + 插入。
