// custom-prompt e2e — verifies the custom-prompt admin surface
// (Phase 10d cycle 4, upgraded to the final filter contract) end-to-end
// against the real AppModule + real Prisma. Admin routes mount under
// /system/custom_prompt (snake_case wire).
//
// This suite verifies the frontend contract
// (api/prompt.ts promptApi + views/system/prompt/index.vue) is satisfied:
//   - POST   /:type/page/:pageNum/:pageSize body { name?, ds_list?, adv_list? }
//     → {current_page, page_size, total_count, total_pages,
//     data: CustomPromptSnake[]} (note `data` + `total_count`, NOT `items` +
//     `total`)
//   - PUT    /  body CustomPromptInfo (id? → create|update) → raw row
//   - DELETE /  body number[] (bare array) → [{id}] (for @SystemLog callback)
//   - POST   /:type/export body { name?, ds_list?, adv_list? } → xlsx blob
//     (bypasses envelope)
//   - GET    /template             → xlsx blob (bypasses envelope)
//   - POST   /:type/uploadExcel    → { data: { success_count, failed_count,
//     duplicate_count, original_count, error_excel_filename } }
//
// beforeAll/afterAll sweep all 3 types (GENERATE_SQL/ANALYSIS/PREDICT_DATA)
// for serial-e2e dev.db hygiene (§104).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T;
}

// Snake wire shape emitted by toCustomPromptSnake (§110).
interface CustomPromptSnake {
  id: number;
  oid: number;
  type: string;
  create_time: number;
  name: string | null;
  prompt: string | null;
  specific_ds: boolean;
  datasource_ids: number[];
  datasource_names: string[];
  advanced_application: number | null;
  advanced_application_name: string | null;
}

interface CustomPromptPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: CustomPromptSnake[];
}

const TYPES = ['GENERATE_SQL', 'ANALYSIS', 'PREDICT_DATA'];

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function sweepAll(app: INestApplication<App>, token: string) {
  const ids: number[] = [];
  for (const type of TYPES) {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/system/custom_prompt/${type}/page/1/1000`)
      .set(TOKEN_HEADER, token)
      .send({});
    const page = (res.body as ApiEnvelope<CustomPromptPage>).data;
    if (page?.data) for (const r of page.data) ids.push(r.id);
  }
  if (ids.length === 0) return;
  await request(app.getHttpServer())
    .delete('/api/v1/system/custom_prompt')
    .set(TOKEN_HEADER, token)
    .send(ids);
}

/** Build a minimal xlsx buffer in-memory for the uploadExcel test. */
async function buildXlsxBuffer(
  rows: Record<string, string>[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('custom_prompt');
  ws.columns = [
    { header: '提示词名称', key: 'name', width: 24 },
    { header: '提示词内容', key: 'prompt', width: 60 },
    { header: '是否限定数据源', key: 'specific_ds', width: 14 },
    { header: '生效数据源', key: 'datasource', width: 24 },
    { header: '高级应用', key: 'advanced_application_name', width: 20 },
  ];
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('CustomPrompt (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const createdIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
    await sweepAll(app, token);
  });

  afterAll(async () => {
    await sweepAll(app, token);
    await app.close();
  });

  it('requires a token for admin routes (401 without)', async () => {
    const res = await request(app.getHttpServer()).post(
      '/api/v1/system/custom_prompt/GENERATE_SQL/page/1/10',
    );
    expect(res.status).toBe(401);
  });

  it('manages the lifecycle (snake wire, pager {data,total_count}, upsert + delete bare array)', async () => {
    const suffix = Date.now();
    try {
      // create (no id) → 200 + raw row (camelCase; frontend doesn't read body)
      const created = await request(app.getHttpServer())
        .put('/api/v1/system/custom_prompt')
        .set(TOKEN_HEADER, token)
        .send({
          type: 'GENERATE_SQL',
          name: `e2e-cp-${suffix}`,
          prompt: 'SELECT * FROM users',
          specific_ds: false,
          datasource_ids: [],
        });
      expect(created.status).toBe(200);
      const cr = (created.body as ApiEnvelope<{ id: number; name: string }>)
        .data;
      expect(cr.name).toBe(`e2e-cp-${suffix}`);
      createdIds.push(cr.id);

      // page → {data, total_count} (NOT items/total); row is snake shape
      // (POST body filter contract)
      const page = await request(app.getHttpServer())
        .post('/api/v1/system/custom_prompt/GENERATE_SQL/page/1/10')
        .set(TOKEN_HEADER, token)
        .send({ name: `e2e-cp-${suffix}` });
      expect(page.status).toBe(200);
      const pageData = (page.body as ApiEnvelope<CustomPromptPage>).data;
      expect(pageData.current_page).toBe(1);
      expect(pageData.page_size).toBe(10);
      expect(pageData.total_count).toBeGreaterThanOrEqual(1);
      expect(pageData.data).toHaveLength(1);
      const row = pageData.data[0];
      expect(row.id).toBe(cr.id);
      expect(row.type).toBe('GENERATE_SQL');
      expect(row.name).toBe(`e2e-cp-${suffix}`);
      expect(row.prompt).toBe('SELECT * FROM users');
      expect(row.specific_ds).toBe(false);
      expect(row.datasource_ids).toEqual([]);
      expect(row.datasource_names).toEqual([]);
      expect(row.advanced_application).toBeNull();
      expect(row.advanced_application_name).toBeNull();
      expect(typeof row.create_time).toBe('number');

      // update (with id) → rename
      const updated = await request(app.getHttpServer())
        .put('/api/v1/system/custom_prompt')
        .set(TOKEN_HEADER, token)
        .send({
          id: cr.id,
          type: 'GENERATE_SQL',
          name: `e2e-cp-renamed-${suffix}`,
          prompt: 'SELECT 1',
        });
      expect(updated.status).toBe(200);

      // page keyword finds the renamed row
      const page2 = await request(app.getHttpServer())
        .post('/api/v1/system/custom_prompt/GENERATE_SQL/page/1/10')
        .set(TOKEN_HEADER, token)
        .send({ name: `e2e-cp-renamed-${suffix}` });
      const page2Data = (page2.body as ApiEnvelope<CustomPromptPage>).data;
      expect(page2Data.data[0].name).toBe(`e2e-cp-renamed-${suffix}`);
      expect(page2Data.data[0].prompt).toBe('SELECT 1');

      // delete (bare array body) → 200 + [{id}]
      const del = await request(app.getHttpServer())
        .delete('/api/v1/system/custom_prompt')
        .set(TOKEN_HEADER, token)
        .send([cr.id]);
      expect(del.status).toBe(200);
      expect((del.body as ApiEnvelope<{ id: number }[]>).data).toEqual([
        { id: cr.id },
      ]);
      createdIds.splice(createdIds.indexOf(cr.id), 1);

      // verify gone
      const page3 = await request(app.getHttpServer())
        .post('/api/v1/system/custom_prompt/GENERATE_SQL/page/1/10')
        .set(TOKEN_HEADER, token)
        .send({ name: `e2e-cp-renamed-${suffix}` });
      const page3Data = (page3.body as ApiEnvelope<CustomPromptPage>).data;
      expect(page3Data.data).toHaveLength(0);
    } finally {
      if (createdIds.length > 0) {
        await request(app.getHttpServer())
          .delete('/api/v1/system/custom_prompt')
          .set(TOKEN_HEADER, token)
          .send([...createdIds]);
        createdIds.length = 0;
      }
    }
  });

  it('rejects upsert with empty name (400)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/custom_prompt')
      .set(TOKEN_HEADER, token)
      .send({ type: 'GENERATE_SQL', name: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for upsert of a non-existent id (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/custom_prompt')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999, type: 'GENERATE_SQL', name: 'ghost' });
    expect(res.status).toBe(404);
    expect(typeof res.text).toBe('string'); // §60 plain-string error
  });

  it('GET /template returns an xlsx blob (bypasses envelope)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/custom_prompt/template')
      .set(TOKEN_HEADER, token)
      .buffer(true)
      .parse((response, done) => {
        const data: Buffer[] = [];
        response.on('data', (chunk: Buffer) => data.push(chunk));
        response.on('end', () => {
          response.body = Buffer.concat(data); // supertest needs .buffer(true) + a binary parser to populate res.body
          done();
        });
      });
    expect(res.status).toBe(200);
    // xlsx magic bytes: PK (zip)
    expect(res.body[0]).toBe(0x50);
    expect(res.body[1]).toBe(0x4b);
    expect(res.headers['content-type']?.includes('spreadsheetml')).toBe(true);
  });

  it('POST /:type/export returns an xlsx blob (bypasses envelope)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/GENERATE_SQL/export')
      .set(TOKEN_HEADER, token)
      .send({})
      .buffer(true)
      .parse((response, done) => {
        const data: Buffer[] = [];
        response.on('data', (chunk: Buffer) => data.push(chunk));
        response.on('end', () => {
          response.body = Buffer.concat(data);
          done();
        });
      });
    expect(res.status).toBe(200);
    expect(res.body[0]).toBe(0x50); // PK
    expect(res.body[1]).toBe(0x4b);
  });

  it('POST /:type/uploadExcel imports rows + returns the summary shape', async () => {
    const suffix = Date.now();
    const buf = await buildXlsxBuffer([
      {
        name: `e2e-import-${suffix}`,
        prompt: 'SELECT 2',
        specific_ds: 'N',
        datasource: '',
        advanced_application_name: '',
      },
    ]);
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/ANALYSIS/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, 'custom_prompt.xlsx');
    expect(res.status).toBe(200);
    const env = (res.body as ApiEnvelope<unknown>).data as {
      success_count: number;
      failed_count: number;
      duplicate_count: number;
      original_count: number;
      error_excel_filename: string | null;
    };
    expect(env.success_count).toBe(1);
    expect(env.failed_count).toBe(0);
    expect(env.original_count).toBe(1);
    expect(env.error_excel_filename).toBeNull();

    // verify the imported row is in the ANALYSIS page
    const page = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/ANALYSIS/page/1/10')
      .set(TOKEN_HEADER, token)
      .send({ name: `e2e-import-${suffix}` });
    const pageData = (page.body as ApiEnvelope<CustomPromptPage>).data;
    expect(pageData.data).toHaveLength(1);
    expect(pageData.data[0].type).toBe('ANALYSIS'); // type from path segment
    expect(pageData.data[0].prompt).toBe('SELECT 2');
    createdIds.push(pageData.data[0].id);

    // P2-4: re-importing the SAME file is idempotent — natural-key upsert
    // updates the existing (oid, type, name) row instead of duplicating it.
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/ANALYSIS/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, 'custom_prompt.xlsx');
    expect(res2.status).toBe(200);
    const env2 = (res2.body as ApiEnvelope<unknown>).data as {
      success_count: number;
      duplicate_count: number;
      original_count: number;
    };
    expect(env2.success_count).toBe(1);
    expect(env2.duplicate_count).toBe(1);
    const page2 = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/ANALYSIS/page/1/10')
      .set(TOKEN_HEADER, token)
      .send({ name: `e2e-import-${suffix}` });
    const pageData2 = (page2.body as ApiEnvelope<CustomPromptPage>).data;
    expect(pageData2.data).toHaveLength(1);
  });
});
