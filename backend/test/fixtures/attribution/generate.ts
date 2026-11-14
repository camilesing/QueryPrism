// Deterministic CSV generator for the attribution-domain fixture.
//
// Source of truth: the FlinkSQL sinks under
// /Users/camile/Work/FlinkSQL/execute-sql/归因域/v1 (DDL only — that pipeline
// has no shipped data). Everything here is synthetic and reproducible: a
// fixed-seed PRNG decides all values, so re-running this script rewrites the
// four CSVs byte-identically. The committed CSVs are the fixture; regenerate
// only via:
//   cd backend && pnpm exec ts-node test/fixtures/attribution/generate.ts
//
// Domain model (mirrors the v1 jobs):
//   visits (dwv_utm_attribution, 200 rows)
//     → orders attributed first/last-touch (dwv_order_conversion_attribution,
//       120 rows) → FB-ad subset (dwv_order_fb_attribution) → per-day
//       store/source rollup (sl_dm_store_referrer_utm_rt, one 'yes' row per
//       attribution side per order-group, so SUM(order_cnt_first) over
//       is_first='yes' equals the order count).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The v1 pipeline derives its *_code columns as md5 of the source URL (see
// the DDL comments) — mirroring that makes identical landing/referrer pages
// collapse to identical codes, so the DM rollup actually aggregates.
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

// ── deterministic PRNG (mulberry32) — no Math.random / Date.now anywhere ──
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRng(0x41545452); // "ATTR"
const int = (min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const hex = (n: number): string => {
  const digits = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < n; i++) out += digits[int(0, 15)];
  return out;
};

// ── fixed 30-day window (2026-10-01 .. 2026-10-30 UTC) ──
const DAY_MS = 86_400_000;
const WINDOW_START = Date.UTC(2026, 9, 1);
const WINDOW_DAYS = 30;
const iso = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ── pools ──
const STORES = ['881001', '881002', '881003'] as const;
const STORE_HOST: Record<string, string> = {
  '881001': 'gearlab.myshopline.com',
  '881002': 'aurora-gear.myshopline.com',
  '881003': 'petite-luxe.myshopline.com',
};
const CHANNELS = [
  'web',
  'live',
  'mc',
  'post',
  'oneshop',
  'shopee',
  'pos',
] as const;

interface SourceDef {
  source: string;
  medium: string;
  refSite: string;
  refName: string;
  refPath: () => string;
  refSource: string;
  fb: boolean; // carries FB campaign/adset/ad ids
}
const SOURCES: SourceDef[] = [
  {
    source: 'google',
    medium: 'cpc',
    refSite: 'www.google.com',
    refName: 'Google',
    refPath: () => `/search?q=${pick(['drone', 'desk lamp', 'skincare'])}`,
    refSource: 'Search',
    fb: false,
  },
  {
    source: 'facebook',
    medium: 'social',
    refSite: 'm.facebook.com',
    refName: 'Facebook',
    refPath: () => '/feed/',
    refSource: 'Social',
    fb: true,
  },
  {
    source: 'instagram',
    medium: 'social',
    refSite: 'www.instagram.com',
    refName: 'Instagram',
    refPath: () => `/reel/${hex(6)}/`,
    refSource: 'Social',
    fb: true,
  },
  {
    source: 'tiktok',
    medium: 'video',
    refSite: 'www.tiktok.com',
    refName: 'TikTok',
    refPath: () => `/@gearlab/video/${hex(11)}`,
    refSource: 'Video',
    fb: false,
  },
  {
    source: 'email',
    medium: 'newsletter',
    refSite: 'mail.mailing.example.com',
    refName: 'Email Newsletter',
    refPath: () => `/campaign/oct-drop-${int(1, 4)}`,
    refSource: 'Email',
    fb: false,
  },
  {
    source: 'influencer',
    medium: 'referral',
    refSite: 'partners.example.com',
    refName: 'Partner Blog',
    refPath: () => `/post/${int(100, 999)}`,
    refSource: 'Referral',
    fb: false,
  },
];
// Weighted source draw: 'direct' (站内, no UTM) is common in the real pipeline.
const SOURCE_DRAW: readonly (SourceDef | 'direct')[] = [
  SOURCES[0],
  SOURCES[1],
  SOURCES[1],
  SOURCES[2],
  SOURCES[2],
  SOURCES[3],
  SOURCES[4],
  SOURCES[5],
  'direct',
  'direct',
];

const LANDING_PATHS = [
  '/products/mini-drone',
  '/products/desk-lamp-pro',
  '/collections/new-arrivals',
  '/pages/halloween-sale',
  '/',
] as const;
const CAMPAIGN_NAMES = [
  'oct-halloween',
  'oct-anniversary',
  'oct-newdrop',
] as const;
const UTM_CONTENTS = ['banner', 'video', 'carousel', 'search'] as const;
const UTM_TERMS = ['drone', 'desk-lamp', 'skincare', 'protein'] as const;
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36',
] as const;
const EXT_INFOS = [
  '{"browser":"Chrome 129","os":"iOS 17","device":"mobile"}',
  '{"browser":"Safari 17","os":"iOS 17","device":"mobile"}',
  '{"browser":"Chrome 129","os":"macOS 14","device":"desktop"}',
] as const;
const AMOUNTS = [1999, 2599, 3999, 4599, 5999, 7999, 12999, 19999] as const;

// ── shared visit shape (drives every downstream table) ──
interface Visit {
  visitorUuid: string;
  store: string;
  startTime: number;
  source: SourceDef | 'direct';
  landingUrl: string;
  landingCode: string;
  landingSite: string;
  landingPath: string;
  referrerUrl: string;
  referrerCode: string;
  referrerSite: string;
  referrerName: string;
  referrerPath: string;
  referrerSource: string;
  utm: {
    content: string;
    medium: string;
    name: string;
    source: string;
    term: string;
    campaign: string;
  };
  utmAd: string;
  utmAdset: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  utmMd5: string;
  utmEmpty: number;
}

function buildVisits(count: number, visitors: string[]): Visit[] {
  const visits: Visit[] = [];
  for (let i = 0; i < count; i++) {
    const visitor = visitors[i % visitors.length];
    const store = pick(STORES);
    const host = STORE_HOST[store];
    const startTime =
      WINDOW_START + int(0, WINDOW_DAYS - 1) * DAY_MS + int(0, 86_399_000);
    const draw = pick(SOURCE_DRAW);
    const landingPath = pick(LANDING_PATHS);
    const landingUrl = `https://${host}${landingPath}`;
    const v: Visit = {
      visitorUuid: visitor,
      store,
      startTime,
      source: draw,
      landingUrl,
      landingCode: md5(landingUrl),
      landingSite: host,
      landingPath,
      referrerUrl: '',
      referrerCode: '',
      referrerSite: '',
      referrerName: '',
      referrerPath: '',
      referrerSource: '',
      utm: {
        content: 'N/A',
        medium: 'N/A',
        name: 'N/A',
        source: 'N/A',
        term: 'N/A',
        campaign: 'N/A',
      },
      utmAd: 'N/A',
      utmAdset: 'N/A',
      campaignId: 'N/A',
      adsetId: 'N/A',
      adId: 'N/A',
      utmMd5: '',
      utmEmpty: 0,
    };
    if (draw === 'direct') {
      v.referrerUrl = 'N/A';
      v.referrerCode = 'N/A';
      v.referrerSite = 'N/A';
      v.referrerName = 'N/A';
      v.referrerPath = 'N/A';
      v.referrerSource = 'Direct';
      v.utmMd5 = 'N/A';
      v.utmEmpty = 1;
    } else {
      const campaign = `${pick(CAMPAIGN_NAMES)}-${int(1, 3)}`;
      const refPath = draw.refPath();
      v.referrerUrl = `https://${draw.refSite}${refPath}`;
      v.referrerCode = md5(v.referrerUrl);
      v.referrerSite = draw.refSite;
      v.referrerName = draw.refName;
      v.referrerPath = refPath;
      v.referrerSource = draw.refSource;
      v.utm = {
        content: pick(UTM_CONTENTS),
        medium: draw.medium,
        name: campaign,
        source: draw.source,
        term: pick(UTM_TERMS),
        campaign,
      };
      v.utmMd5 = md5(
        [
          v.utm.content,
          v.utm.medium,
          v.utm.name,
          v.utm.source,
          v.utm.term,
          v.utm.campaign,
        ].join('_'),
      );
      if (draw.fb) {
        v.utmAd = `ad_${hex(8)}`;
        v.utmAdset = `adset_${hex(8)}`;
        v.campaignId = String(int(620000000, 620999999));
        v.adsetId = String(int(238000000, 238999999));
        v.adId = String(int(120000000, 120999999));
      }
    }
    visits.push(v);
  }
  visits.sort((a, b) => a.startTime - b.startTime);
  return visits;
}

function utmJson(v: Visit): string {
  const u = v.utm;
  return JSON.stringify({
    utm_source: u.source,
    utm_medium: u.medium,
    utm_campaign: u.campaign,
    utm_content: u.content,
    utm_term: u.term,
  });
}

interface Order {
  seq: string;
  store: string;
  visitorUuid: string;
  buyerId: string;
  orderTime: number;
  orderNum: number;
  interactDays: number;
  interactCount: number;
  first: Visit;
  last: Visit;
  amount: number; // cents — only surfaces in the DM rollup
  channel: string;
  isOffline: number;
}

function buildOrders(
  count: number,
  visitors: string[],
  visitsByVisitor: Map<string, Visit[]>,
): Order[] {
  const buyerByVisitor = new Map<string, string>(
    visitors.map((v) => [v, `b${int(100000, 999999)}`]),
  );
  const orderNumByBuyer = new Map<string, number>();
  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    const visitor = visitors[i % visitors.length];
    const visits = visitsByVisitor.get(visitor) ?? [];
    const lastIdx = int(0, visits.length - 1);
    const firstIdx = int(0, lastIdx);
    const first = visits[firstIdx];
    const last = visits[lastIdx];
    const orderTime = last.startTime + int(3_600_000, 3 * DAY_MS);
    const buyer = buyerByVisitor.get(visitor) ?? `b${int(100000, 999999)}`;
    const orderNum = (orderNumByBuyer.get(buyer) ?? 0) + 1;
    orderNumByBuyer.set(buyer, orderNum);
    orders.push({
      seq: `SO2610${String(1000 + i)}`,
      store: last.store,
      visitorUuid: visitor,
      buyerId: buyer,
      orderTime,
      orderNum,
      interactDays: Math.floor((orderTime - first.startTime) / DAY_MS),
      interactCount: lastIdx - firstIdx + 1,
      first,
      last,
      amount: pick(AMOUNTS),
      channel: pick(CHANNELS),
      isOffline: rand() < 0.06 ? 1 : 0,
    });
  }
  return orders;
}

// ── CSV writer (every field quoted — RFC4180-safe, `.import --csv` happy) ──
function toCsv(
  header: readonly string[],
  rows: readonly (string | number)[][],
): string {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

function main(): void {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
  const visitors = Array.from({ length: 70 }, () => hex(16));
  const visits = buildVisits(200, visitors);
  const visitsByVisitor = new Map<string, Visit[]>();
  for (const v of visits) {
    const arr = visitsByVisitor.get(v.visitorUuid) ?? [];
    arr.push(v);
    visitsByVisitor.set(v.visitorUuid, arr);
  }
  const orders = buildOrders(120, visitors, visitsByVisitor);

  // 1) dwv_utm_attribution
  const utmHeader = [
    'id',
    'visitor_uuid',
    'store_id',
    'uid',
    'biz_source',
    'landing_url',
    'referrer_url',
    'user_agent',
    'client_ip',
    'start_time',
    'ext_info',
    'create_time',
    'session_id',
    'session_create_type',
    'last_session_id',
    'redirect_type',
    'landing_page_url_code',
    'landing_page_site',
    'landing_page_path',
    'utm_content',
    'utm_medium',
    'utm_name',
    'utm_source',
    'utm_term',
    'utm_campaign',
    'utm_ad',
    'utm_adset',
    'campaign_id',
    'adset_id',
    'ad_id',
    'sl_source_ad_id',
    'sl_source_ad_platform',
    'sl_source_campaign_id',
    'sl_source_placement',
    'referrer_url_code',
    'referrer_site',
    'referrer_name',
    'referrer_path',
    'referrer_source',
    'visit_type',
    'utm_md5',
    'utm_empty',
    'is_offline',
    'update_time',
  ];
  const utmRows = visits.map((v, i) => {
    const sessionId = `sess-${hex(12)}`;
    return [
      i + 1,
      v.visitorUuid,
      v.store,
      `u${int(10000, 99999)}`,
      'shopline',
      v.landingUrl,
      v.referrerUrl,
      pick(USER_AGENTS),
      `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`,
      iso(v.startTime),
      pick(EXT_INFOS),
      iso(v.startTime - int(60_000, 900_000)),
      sessionId,
      pick(['first', 'revisit']),
      `sess-${hex(12)}`,
      rand() < 0.1 ? 1 : 0,
      v.landingCode,
      v.landingSite,
      v.landingPath,
      v.utm.content,
      v.utm.medium,
      v.utm.name,
      v.utm.source,
      v.utm.term,
      v.utm.campaign,
      v.utmAd,
      v.utmAdset,
      v.campaignId,
      v.adsetId,
      v.adId,
      v.source === 'direct' ? 'N/A' : `sl_ad_${hex(6)}`,
      v.source === 'direct' ? 'N/A' : 'zhuge',
      v.source === 'direct' ? 'N/A' : String(int(70000000, 70099999)),
      v.source === 'direct' ? 'N/A' : pick(['feed', 'story', 'search']),
      v.referrerCode,
      v.referrerSite,
      v.referrerName,
      v.referrerPath,
      v.referrerSource,
      v.source === 'direct' ? 'Direct' : 'Web',
      v.utmMd5,
      v.utmEmpty,
      rand() < 0.05 ? 1 : 0,
      iso(v.startTime + int(1_000, 60_000)),
    ];
  });

  // 2) dwv_order_conversion_attribution
  const convHeader = [
    'store_id',
    'visitor_uuid',
    'buyer_id',
    'order_seq',
    'order_num',
    'interact_days',
    'interact_count',
    'first_interact_source',
    'first_interact_time',
    'first_interact_url',
    'first_interact_utm',
    'last_interact_source',
    'last_interact_time',
    'last_interact_url',
    'last_interact_utm',
    'is_offline',
    'update_time',
    'first_interact_referer_url',
    'last_interact_referer_url',
  ];
  const convRows = orders.map((o) => [
    o.store,
    o.visitorUuid,
    o.buyerId,
    o.seq,
    o.orderNum,
    o.interactDays,
    o.interactCount,
    o.first.source === 'direct' ? 'Direct' : o.first.source.source,
    iso(o.first.startTime),
    o.first.landingUrl,
    utmJson(o.first),
    o.last.source === 'direct' ? 'Direct' : o.last.source.source,
    iso(o.last.startTime),
    o.last.landingUrl,
    utmJson(o.last),
    o.isOffline,
    iso(o.orderTime + 300_000),
    o.first.referrerUrl,
    o.last.referrerUrl,
  ]);

  // 3) dwv_order_fb_attribution — orders whose FIRST touch ran via FB ads
  const fbHeader = [
    'store_id',
    'visitor_uuid',
    'buyer_id',
    'order_seq',
    'order_time',
    'campaign_id',
    'adset_id',
    'ad_id',
    'is_offline',
    'update_time',
  ];
  const fbRows = orders
    .filter((o) => o.first.source !== 'direct' && o.first.source.fb)
    .map((o) => [
      o.store,
      o.visitorUuid,
      o.buyerId,
      o.seq,
      iso(o.orderTime),
      o.first.campaignId,
      o.first.adsetId,
      o.first.adId,
      o.isOffline,
      iso(o.orderTime + 300_000),
    ]);

  // 4) sl_dm_store_referrer_utm_rt — first/last rollup per (store, day, dim)
  const dmHeader = [
    'dim_key',
    'app_id',
    'store_id',
    'stat_date',
    'landing_page_url_code',
    'landing_page_url',
    'landing_page_site',
    'landing_page_path',
    'utm_content',
    'utm_medium',
    'utm_name',
    'utm_source',
    'utm_term',
    'referrer_url_code',
    'referrer_url',
    'referrer_site',
    'referrer_name',
    'referrer_path',
    'referrer_source',
    'total_amount_first',
    'order_cnt_first',
    'total_amount_last',
    'order_cnt_last',
    'execute_time',
    'update_time',
    'is_realtime',
    'sales_channel',
    'is_first',
    'is_last',
  ];
  interface DmAcc {
    dimKey: string;
    store: string;
    statDate: string;
    touch: Visit;
    amountFirst: number;
    cntFirst: number;
    amountLast: number;
    cntLast: number;
    executeTime: number;
    channel: string;
    isRealtime: number;
    isFirst: string;
    isLast: string;
  }
  const dm = new Map<string, DmAcc>();
  const rollup = (touch: Visit, o: Order, first: boolean): void => {
    const dimKey = `${touch.landingCode}_${touch.referrerCode}_${o.channel}`;
    const statDate = dayKey(o.orderTime);
    const key = `${o.store}|${statDate}|${dimKey}|${first ? 'f' : 'l'}`;
    let acc = dm.get(key);
    if (!acc) {
      acc = {
        dimKey,
        store: o.store,
        statDate,
        touch,
        amountFirst: 0,
        cntFirst: 0,
        amountLast: 0,
        cntLast: 0,
        executeTime: o.orderTime,
        channel: o.channel,
        isRealtime: rand() < 0.1 ? 1 : 0,
        isFirst: first ? 'yes' : 'no',
        isLast: first ? 'no' : 'yes',
      };
      dm.set(key, acc);
    }
    if (first) {
      acc.amountFirst += o.amount;
      acc.cntFirst += 1;
    } else {
      acc.amountLast += o.amount;
      acc.cntLast += 1;
    }
    acc.executeTime = Math.max(acc.executeTime, o.orderTime);
  };
  for (const o of orders) {
    rollup(o.first, o, true);
    rollup(o.last, o, false);
  }
  const dmRows = [...dm.values()]
    .sort((a, b) =>
      a.store === b.store
        ? a.statDate === b.statDate
          ? a.dimKey.localeCompare(b.dimKey)
          : a.statDate.localeCompare(b.statDate)
        : a.store.localeCompare(b.store),
    )
    .map((a) => [
      a.dimKey,
      'qp-attribution',
      a.store,
      a.statDate,
      a.touch.landingCode,
      a.touch.landingUrl,
      a.touch.landingSite,
      a.touch.landingPath,
      a.touch.utm.content,
      a.touch.utm.medium,
      a.touch.utm.name,
      a.touch.utm.source,
      a.touch.utm.term,
      a.touch.referrerCode,
      a.touch.referrerUrl,
      a.touch.referrerSite,
      a.touch.referrerName,
      a.touch.referrerPath,
      a.touch.referrerSource,
      a.amountFirst,
      a.cntFirst,
      a.amountLast,
      a.cntLast,
      iso(a.executeTime),
      iso(a.executeTime + 60_000),
      a.isRealtime,
      a.channel,
      a.isFirst,
      a.isLast,
    ]);

  const files: [string, readonly string[], readonly (string | number)[][]][] = [
    ['dwv_utm_attribution.csv', utmHeader, utmRows],
    ['dwv_order_conversion_attribution.csv', convHeader, convRows],
    ['dwv_order_fb_attribution.csv', fbHeader, fbRows],
    ['sl_dm_store_referrer_utm_rt.csv', dmHeader, dmRows],
  ];
  for (const [name, header, rows] of files) {
    fs.writeFileSync(path.join(outDir, name), toCsv(header, rows), 'utf8');

    console.log(`${name}: ${rows.length} rows`);
  }
}

main();
