// Attribution-domain fixture loader — shared by attribution-governance /
// attribution-chat e2e specs. Builds a throwaway SQLite file from the
// committed CSVs under test/fixtures/attribution (schema.sql + 4 tables) and
// registers it as a QueryPrism datasource, isolated from seed DS 1.
//
// The CSVs are the single source of truth: tests compute expected aggregates
// from readAttributionCsv() instead of hard-coding numbers, so regenerating
// the fixture never breaks the specs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import Database from 'better-sqlite3';
import { encryptFrontendConfig } from '../../src/datasource/frontend-config-crypto';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'attribution');

/** table file stem → synced table_comment (Chinese, from the fql DDL). */
export const ATTRIBUTION_TABLES: readonly { name: string; comment: string }[] =
  [
    {
      name: 'dwv_utm_attribution',
      comment: '广告UTM归因明细表(访问触点)',
    },
    {
      name: 'dwv_order_conversion_attribution',
      comment: '订单转化归因表(首触/末触)',
    },
    {
      name: 'dwv_order_fb_attribution',
      comment: '订单FB广告归因表',
    },
    {
      name: 'sl_dm_store_referrer_utm_rt',
      comment: '店铺来源UTM实时汇总表',
    },
  ];

export interface AttributionCsv {
  header: string[];
  /** rows keyed by column name (all values as CSV strings). */
  rows: Record<string, string>[];
}

/** Minimal RFC4180 parser — the generator quotes every field, but this also
 *  copes with unquoted cells. No multiline fields in this fixture. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // skip fully empty trailing lines
      if (row.length > 1 || row[0] !== '') out.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export function readAttributionCsv(name: string): AttributionCsv {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.csv`), 'utf8');
  const [header, ...rest] = parseCsv(raw);
  if (!header) throw new Error(`empty CSV: ${name}`);
  return {
    header,
    rows: rest.map((cells) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = cells[i] ?? ''));
      return o;
    }),
  };
}

/** INTEGER-typed columns per table, parsed out of schema.sql so the SQLite
 *  file keeps real numeric types (SUM/GROUP BY behave, not TEXT coercion). */
function numericColumns(table: string): Set<string> {
  const ddl = fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8');
  const m = ddl.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  if (!m) throw new Error(`table not found in schema.sql: ${table}`);
  const cols = new Set<string>();
  for (const line of m[1].split('\n')) {
    const col = line.trim().match(/^([a-z0-9_]+) INTEGER/);
    if (col) cols.add(col[1]);
  }
  return cols;
}

/** Create the SQLite file (schema + all CSV rows) at `dbPath`. */
export function buildAttributionDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(fs.readFileSync(path.join(FIXTURE_DIR, 'schema.sql'), 'utf8'));
    for (const { name } of ATTRIBUTION_TABLES) {
      const { header, rows } = readAttributionCsv(name);
      const numeric = numericColumns(name);
      const stmt = db.prepare(
        `INSERT INTO ${name} (${header.map((c) => `"${c}"`).join(',')}) VALUES (${header
          .map(() => '?')
          .join(',')})`,
      );
      const insertAll = db.transaction((list: Record<string, string>[]) => {
        for (const r of list) {
          stmt.run(
            ...header.map((c) => (numeric.has(c) ? Number(r[c]) : r[c])),
          );
        }
      });
      insertAll(rows);
    }
  } finally {
    db.close();
  }
}

export interface AttributionDatasource {
  dsId: number;
  dbPath: string;
}

/** POST /datasource/add with the four tables pre-synced (checked). */
export async function createAttributionDatasource(
  app: INestApplication<App>,
  token: string,
  dbPath: string,
  name: string,
): Promise<AttributionDatasource> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/datasource/add')
    .set(TOKEN_HEADER, token)
    .send({
      name,
      description: '归因域 e2e fixture',
      type: 'sqlite',
      configuration: encryptFrontendConfig({ db: dbPath }),
      tables: ATTRIBUTION_TABLES.map((t) => ({
        table_name: t.name,
        table_comment: t.comment,
      })),
    });
  if (res.status !== 200) {
    throw new Error(`datasource add failed: ${res.status} ${res.text}`);
  }
  return { dsId: res.body.data.id as number, dbPath };
}

/** Delete route is /datasource/delete/:id/:name (both must match). */
export async function removeAttributionDatasource(
  app: INestApplication<App>,
  token: string,
  ds: AttributionDatasource,
  name: string,
): Promise<void> {
  await request(app.getHttpServer())
    .post(`/api/v1/datasource/delete/${ds.dsId}/${encodeURIComponent(name)}`)
    .set(TOKEN_HEADER, token)
    .catch(() => undefined);
  if (fs.existsSync(ds.dbPath)) fs.unlinkSync(ds.dbPath);
}
