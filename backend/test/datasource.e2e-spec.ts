// Datasource e2e — Phase 10 §90/§91/§92/§96. Covers all 26 routes of the
// rewritten datasource.controller + table-relation.controller against the
// real AppModule + a fresh temp-sqlite DS (isolated from seed DS 1, which
// the chat/dashboard/mcp suites depend on). Sequenced as one ordered flow:
// add → check/introspect → chooseTables → tableList/fieldList/preview →
// edit/sync → execSql/importToDb/update → export → table_relation → delete.
//
// Casing assertions:
//  - list/get/add/update/tableList/fieldList → snake_case (no createdAt etc.)
//  - getTables/getTablesByConf/getFields → camelCase {tableName, fieldName}
//  - configuration → the encrypted STRING passed in add (stored verbatim)
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { encryptFrontendConfig } from './../src/datasource/frontend-config-crypto';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface DatasourceSnake {
  id: number;
  name: string;
  description: string | null;
  type: string;
  type_name: string;
  configuration: string | null;
  status: string | null;
  table_relation: unknown;
  recommended_config: unknown;
  num: string;
  create_time: string;
}

interface TableSnake {
  id: number;
  ds_id: number;
  table_name: string;
  table_comment: string | null;
  custom_comment: string | null;
  checked: boolean;
}

interface FieldSnake {
  id: number;
  table_id: number;
  field_name: string;
  field_type: string | null;
  field_comment: string | null;
  custom_comment: string | null;
  checked: boolean;
  field_index: number;
}

async function login(
  app: INestApplication<App>,
  username = 'admin',
  password = 'admin',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username, password });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Datasource + table_relation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  const stamp = Date.now();
  let tempDbPath: string;
  let configuration: string;
  let dsId: number;
  let tableId: number;
  let fieldId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);

    // A fresh sqlite file with two tables + sample rows. Isolated from the
    // seed DS 1 so the chat/dashboard/mcp suites are unaffected.
    tempDbPath = `/tmp/test-ds-e2e-${stamp}.db`;
    const db = new Database(tempDbPath);
    db.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)',
    );
    db.exec(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL)',
    );
    db.exec(
      "INSERT INTO users (id, name, email) VALUES (1, 'alice', 'a@x.com')",
    );
    db.exec('INSERT INTO orders (id, user_id, total) VALUES (1, 1, 9.99)');
    db.close();
    configuration = encryptFrontendConfig({ db: tempDbPath });
  });

  afterAll(async () => {
    await app.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  // ─── add (create DS, no tables yet) ───────────────────────────────────

  it('POST /datasource/add creates a DS and returns snake_case (configuration verbatim)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-${stamp}`,
        description: 'e2e temp datasource',
        type: 'sqlite',
        configuration,
      });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<DatasourceSnake>;
    expect(body.code).toBe(0);
    expect(body.data.id).toEqual(expect.any(Number));
    expect(body.data.name).toBe(`e2e-${stamp}`);
    expect(body.data.type).toBe('sqlite');
    expect(body.data.type_name).toBe('SQLite');
    // configuration is stored VERBATIM (the frontend ciphertext, not re-encrypted)
    expect(body.data.configuration).toBe(configuration);
    expect(body.data.create_time).toEqual(expect.any(String));
    // snake fields present, camelCase absent
    expect(
      (body.data as unknown as Record<string, unknown>).createdAt,
    ).toBeUndefined();
    dsId = body.data.id;
  });

  // ─── list / get ────────────────────────────────────────────────────────

  it('GET /datasource/list returns snake_case rows including the new DS', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<DatasourceSnake[]>;
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((d) => d.id === dsId)).toBe(true);
  });

  it('POST /datasource/get/:id returns the snake_case DS (configuration verbatim)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/get/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<DatasourceSnake>;
    expect(body.data.id).toBe(dsId);
    expect(body.data.configuration).toBe(configuration);
  });

  it('POST /datasource/get/:id 404s for a missing DS', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/get/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  // ─── check ────────────────────────────────────────────────────────────

  it('GET /datasource/check/:id returns true for a reachable stored DS', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/datasource/check/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<boolean>).data).toBe(true);
  });

  it('POST /datasource/check returns true for a reachable config', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/check')
      .set(TOKEN_HEADER, token)
      .send({ type: 'sqlite', configuration });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<boolean>).data).toBe(true);
  });

  it('POST /datasource/check returns false for an unopenable path', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/check')
      .set(TOKEN_HEADER, token)
      .send({
        type: 'sqlite',
        configuration: encryptFrontendConfig({
          db: '/nonexistent-dir-does-not-exist/x.db',
        }),
      });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<boolean>).data).toBe(false);
  });

  // ─── live introspection (camelCase) ───────────────────────────────────

  it('POST /datasource/getTables/:id returns [{tableName, tableComment}] (camelCase)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/getTables/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{ tableName: string }[]>;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((t) => t.tableName === 'users')).toBe(true);
    expect(body.data.some((t) => t.tableName === 'orders')).toBe(true);
  });

  it('POST /datasource/getTablesByConf returns [{tableName, tableComment}] (camelCase)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/getTablesByConf')
      .set(TOKEN_HEADER, token)
      .send({ type: 'sqlite', configuration });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{ tableName: string }[]>;
    expect(body.data.some((t) => t.tableName === 'users')).toBe(true);
  });

  it('POST /datasource/getFields/:id/:table_name returns [{fieldName, fieldType}] (camelCase)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/getFields/${dsId}/users`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{ fieldName: string }[]>;
    expect(body.data.some((f) => f.fieldName === 'id')).toBe(true);
    expect(body.data.some((f) => f.fieldName === 'name')).toBe(true);
  });

  it('POST /datasource/getSchemaByConf returns [] for sqlite (no schema layer)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/getSchemaByConf')
      .set(TOKEN_HEADER, token)
      .send({ type: 'sqlite', configuration });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<unknown[]>).data).toEqual([]);
  });

  // ─── chooseTables (persist tables + fields) ───────────────────────────

  it('POST /datasource/chooseTables/:id persists the selection + returns {success}', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/chooseTables/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send([
        { table_name: 'users', table_comment: '用户表' },
        { table_name: 'orders', table_comment: '订单表' },
      ]);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  it('GET /datasource/list reflects the "selected/total" num snapshot after chooseTables', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const rows = (res.body as ApiEnvelope<DatasourceSnake[]>).data;
    const ds = rows.find((d) => d.id === dsId)!;
    // The temp sqlite has 2 tables (users, orders); both were selected.
    expect(ds.num).toBe('2/2');
  });

  // ─── persisted rows (snake) ────────────────────────────────────────────

  it('POST /datasource/tableList/:id returns snake_case Table rows', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/tableList/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<TableSnake[]>;
    expect(body.data.length).toBe(2);
    const users = body.data.find((t) => t.table_name === 'users')!;
    expect(users.table_comment).toBe('用户表');
    expect(users.checked).toBe(true);
    expect(users.ds_id).toBe(dsId);
    tableId = users.id;
  });

  it('POST /datasource/fieldList/:id (table id) returns snake_case Field rows', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/fieldList/${tableId}`)
      .set(TOKEN_HEADER, token)
      .send({ fieldName: '' });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<FieldSnake[]>;
    expect(body.data.some((f) => f.field_name === 'id')).toBe(true);
    expect(body.data.some((f) => f.field_name === 'name')).toBe(true);
    fieldId = body.data.find((f) => f.field_name === 'id')!.id;
  });

  it('POST /datasource/fieldList applies the fieldName LIKE filter', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/fieldList/${tableId}`)
      .set(TOKEN_HEADER, token)
      .send({ fieldName: 'name' });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<FieldSnake[]>;
    expect(body.data.every((f) => f.field_name.includes('name'))).toBe(true);
  });

  // ─── previewData ───────────────────────────────────────────────────────

  it('POST /datasource/previewData/:id returns {fields, data, sql} projected to checked fields', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/previewData/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({ table: { id: tableId }, fields: [] });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{
      fields: string[];
      data: Record<string, unknown>[];
      sql: string;
    }>;
    expect(body.data.fields).toContain('id');
    expect(body.data.fields).toContain('name');
    expect(body.data.data.length).toBe(1);
    expect(body.data.data[0].name).toBe('alice');
  });

  // ─── editTable / editField (persist checked + custom_comment only) ─────

  it('POST /datasource/editTable updates checked + custom_comment', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/editTable')
      .set(TOKEN_HEADER, token)
      .send({ id: tableId, custom_comment: '用户表备注', checked: false });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // re-fetch + verify
    const list = await request(app.getHttpServer())
      .post(`/api/v1/datasource/tableList/${dsId}`)
      .set(TOKEN_HEADER, token);
    const users = (list.body as ApiEnvelope<TableSnake[]>).data.find(
      (t) => t.id === tableId,
    )!;
    expect(users.checked).toBe(false);
    expect(users.custom_comment).toBe('用户表备注');
    // restore checked for previewData/syncFields below
    await request(app.getHttpServer())
      .post('/api/v1/datasource/editTable')
      .set(TOKEN_HEADER, token)
      .send({ id: tableId, checked: true });
  });

  it('POST /datasource/editField updates custom_comment', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/editField')
      .set(TOKEN_HEADER, token)
      .send({ id: fieldId, custom_comment: '主键' });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  it('POST /datasource/editLocalComment returns {success} (stub, unused)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/editLocalComment')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  // ─── syncFields ─────────────────────────────────────────────────────────

  it('POST /datasource/syncFields/:id (table id) re-syncs + returns {success}', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/syncFields/${tableId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  // ─── execSql ────────────────────────────────────────────────────────────

  it('POST /datasource/execSql/:id runs a read-only statement', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/execSql/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({ sql: 'SELECT 1 AS one' });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<unknown>).code).toBe(0);
  });

  // ─── Excel: parseExcel → importToDb → excel datasource → delete ─────────

  it('runs the local Excel datasource round-trip', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['id', 'name', 'score']);
    ws.addRow([1, 'Alice', 90]);
    ws.addRow([2, 'Bob', 75]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const parsed = await request(app.getHttpServer())
      .post('/api/v1/datasource/parseExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, 'excel-e2e.xlsx');
    expect(parsed.status).toBe(200);
    const preview = (
      parsed.body as ApiEnvelope<{
        filePath: string;
        data: Array<{
          sheetName: string;
          fields: Array<{ fieldName: string; fieldType: string }>;
          data: unknown[];
          rows: number;
        }>;
      }>
    ).data;
    expect(preview.filePath).toMatch(/\.xlsx$/);
    expect(preview.data[0].rows).toBe(2);
    expect(preview.data[0].fields.map((f) => f.fieldName)).toEqual([
      'id',
      'name',
      'score',
    ]);

    const imported = await request(app.getHttpServer())
      .post('/api/v1/datasource/importToDb')
      .set(TOKEN_HEADER, token)
      .send({
        filePath: preview.filePath,
        sheets: [
          {
            sheetName: preview.data[0].sheetName,
            fields: preview.data[0].fields,
          },
        ],
      });
    expect(imported.status).toBe(200);
    const sheets = (
      imported.body as ApiEnvelope<{
        filename: string;
        sheets: Array<{
          sheetName: string;
          tableName: string;
          tableComment: string;
          rows: number;
        }>;
      }>
    ).data.sheets;
    expect(sheets[0].rows).toBe(2);
    const tableName = sheets[0].tableName;

    const added = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, token)
      .send({
        name: `excel-${stamp}`,
        type: 'excel',
        configuration: encryptFrontendConfig({
          filename: preview.filePath,
          sheets,
        }),
        tables: sheets.map((s) => ({
          table_name: s.tableName,
          table_comment: s.tableComment,
        })),
      });
    expect(added.status).toBe(200);
    const excelId = (added.body as ApiEnvelope<DatasourceSnake>).data.id;

    const executed = await request(app.getHttpServer())
      .post(`/api/v1/datasource/execSql/${excelId}`)
      .set(TOKEN_HEADER, token)
      .send({ sql: `SELECT COUNT(*) AS c FROM "${tableName}"` });
    expect(executed.status).toBe(200);
    expect((executed.body as ApiEnvelope<unknown>).code).toBe(0);

    const deleted = await request(app.getHttpServer())
      .post(`/api/v1/datasource/delete/${excelId}/excel-${stamp}`)
      .set(TOKEN_HEADER, token);
    expect(deleted.status).toBe(200);
  });

  // ─── update (body with id) ──────────────────────────────────────────────

  it('POST /datasource/update (body with id) updates + returns snake_case', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/update')
      .set(TOKEN_HEADER, token)
      .send({ id: dsId, name: `e2e-${stamp}-renamed` });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<DatasourceSnake>;
    expect(body.data.name).toBe(`e2e-${stamp}-renamed`);
  });

  it('POST /datasource/update 400s when id is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/update')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id' });
    expect(res.status).toBe(400);
  });

  // ─── exportDsSchema (xlsx blob) ─────────────────────────────────────────

  it('GET /datasource/exportDsSchema/:id returns an xlsx blob', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/datasource/exportDsSchema/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    // xlsx is a zip — starts with the PK magic bytes 0x50 0x4b.
    expect((res.text ?? '').length).toBeGreaterThan(0);
  });

  it('GET /datasource/exportDsSchema/0 returns the template blob', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/datasource/exportDsSchema/0')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });

  // ─── table_relation (bare-array X6 cells, Json passthrough) ────────────

  it('POST /table_relation/get/:id returns [] before any save', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/get/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<unknown[]>).data).toEqual([]);
  });

  it('POST /table_relation/save/:dsId stores the X6 cells verbatim', async () => {
    const cells = [
      { shape: 'er-rect', id: 't1', position: { x: 0, y: 0 } },
      {
        shape: 'edge',
        source: { cell: 't1', port: 'f1' },
        target: { cell: 't2', port: 'f2' },
      },
    ];
    const res = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/save/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send(cells);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    const get = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/get/${dsId}`)
      .set(TOKEN_HEADER, token);
    const data = (get.body as ApiEnvelope<unknown[]>).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  // ─── delete ─────────────────────────────────────────────────────────────

  it('POST /datasource/delete/:id/:name removes the DS + returns {success}; chats SURVIVE with datasourceId=null (P1-2)', async () => {
    // Seed a chat pointing at this DS — the nullable "pick one later" field
    // must reset to null, not annihilate the conversation (review P1-2:
    // the old onDelete:Cascade destroyed every chat of a removed DS).
    const chat = await prisma.chat.create({
      data: { oid: 1, datasourceId: dsId, title: 'e2e-cascade-keep' },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/delete/${dsId}/${stamp}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    // confirm gone
    const gone = await request(app.getHttpServer())
      .post(`/api/v1/datasource/get/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(gone.status).toBe(404);

    // confirm the chat survived with the FK reset to null
    const survivor = await prisma.chat.findUnique({ where: { id: chat.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.datasourceId).toBeNull();
    await prisma.chat.delete({ where: { id: chat.id } }).catch(() => undefined);
  });

  // ─── guard (§90) — unauthenticated requests are rejected ───────────────

  it('rejects unauthenticated GET /datasource/list with 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/datasource/list',
    );
    expect(res.status).toBe(401);
  });
});
