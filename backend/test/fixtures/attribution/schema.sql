-- Attribution-domain fixture schema (SQLite), see README.md for the column
-- rename mapping. Manual import:
--   sqlite3 attr.db < schema.sql
--   sqlite3 attr.db ".import --csv --skip 1 dwv_utm_attribution.csv dwv_utm_attribution"  # run from this dir
--
-- Type mapping: String→TEXT, BIGINT/INT→INTEGER,
-- TIMESTAMP(3)→TEXT (ISO-8601), BOOLEAN→INTEGER (0/1).

CREATE TABLE IF NOT EXISTS dwv_utm_attribution (
  id INTEGER PRIMARY KEY,
  visitor_uuid TEXT,             -- was uuid
  store_id TEXT,
  uid TEXT,
  biz_source TEXT,               -- was slt
  landing_url TEXT,              -- was land_url
  referrer_url TEXT,             -- was referer_url
  user_agent TEXT,
  client_ip TEXT,                -- was user_ip
  start_time TEXT,               -- attribution time
  ext_info TEXT,
  create_time TEXT,
  session_id TEXT,
  session_create_type TEXT,
  last_session_id TEXT,
  redirect_type INTEGER,
  landing_page_url_code TEXT,
  landing_page_site TEXT,
  landing_page_path TEXT,
  utm_content TEXT,
  utm_medium TEXT,
  utm_name TEXT,
  utm_source TEXT,
  utm_term TEXT,
  utm_campaign TEXT,
  utm_ad TEXT,
  utm_adset TEXT,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  sl_source_ad_id TEXT,
  sl_source_ad_platform TEXT,
  sl_source_campaign_id TEXT,
  sl_source_placement TEXT,
  referrer_url_code TEXT,
  referrer_site TEXT,
  referrer_name TEXT,
  referrer_path TEXT,
  referrer_source TEXT,
  visit_type TEXT,
  utm_md5 TEXT,
  utm_empty INTEGER,
  is_offline INTEGER,
  update_time TEXT
);

CREATE TABLE IF NOT EXISTS dwv_order_conversion_attribution (
  store_id TEXT,
  visitor_uuid TEXT,             -- was uuid
  buyer_id TEXT,
  order_seq TEXT PRIMARY KEY,
  order_num INTEGER,
  interact_days INTEGER,         -- was interact_day
  interact_count INTEGER,        -- was interact_cnt
  first_interact_source TEXT,
  first_interact_time TEXT,
  first_interact_url TEXT,
  first_interact_utm TEXT,
  last_interact_source TEXT,
  last_interact_time TEXT,
  last_interact_url TEXT,
  last_interact_utm TEXT,
  is_offline INTEGER,
  update_time TEXT,
  first_interact_referer_url TEXT,
  last_interact_referer_url TEXT
);

CREATE TABLE IF NOT EXISTS dwv_order_fb_attribution (
  store_id TEXT,
  visitor_uuid TEXT,             -- was uuid
  buyer_id TEXT,
  order_seq TEXT PRIMARY KEY,
  order_time TEXT,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  is_offline INTEGER,
  update_time TEXT
);

CREATE TABLE IF NOT EXISTS sl_dm_store_referrer_utm_rt (
  dim_key TEXT,                  -- was row_key
  app_id TEXT,
  store_id TEXT,
  stat_date TEXT,                -- was dt
  landing_page_url_code TEXT,
  landing_page_url TEXT,
  landing_page_site TEXT,
  landing_page_path TEXT,
  utm_content TEXT,
  utm_medium TEXT,
  utm_name TEXT,
  utm_source TEXT,
  utm_term TEXT,
  referrer_url_code TEXT,
  referrer_url TEXT,
  referrer_site TEXT,
  referrer_name TEXT,
  referrer_path TEXT,
  referrer_source TEXT,
  total_amount_first INTEGER,    -- revenue in cents (first touch)
  order_cnt_first INTEGER,       -- order count (first touch)
  total_amount_last INTEGER,     -- revenue in cents (last touch)
  order_cnt_last INTEGER,        -- order count (last touch)
  execute_time TEXT,
  update_time TEXT,
  is_realtime INTEGER,           -- 0=realtime, 1=offline
  sales_channel TEXT,
  is_first TEXT,                 -- yes/no
  is_last TEXT,                  -- yes/no
  PRIMARY KEY (store_id, stat_date, dim_key, is_first, is_last)
);
