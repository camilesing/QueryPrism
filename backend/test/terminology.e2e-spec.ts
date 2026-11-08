// terminology e2e — Phase 10c cycle 4 §82/§83/§88/§91/§92/§100/§104. Covers
// the 7 /system/terminology routes + the 401 guard + the repeated-`ds_list`
// query filter + the xlsx blob export/template + the multipart uploadExcel +
// a full-pipeline @SystemLog write→read round-trip. Mirrors cycle 3 audit
// e2e's setup (X-QUERYPRISM-TOKEN header, api/v1 prefix, beforeAll/afterAll
// cleanup, fire-and-forget 100ms wait for the audit record()).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';
import { waitFor } from './helpers/wait-for';
import { PrismaService } from './../src/database/prisma.service';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface TerminologySnake {
  id: number;
  word: string;
  description: string | null;
  other_words: string[];
  specific_ds: boolean;
  datasource_ids: number[];
  datasource_names: string[];
  enabled: boolean;
  advanced_application: number | null;
  advanced_application_name: string | null;
  create_time: number;
}

interface TerminologyPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: TerminologySnake[];
}

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

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

/** Build an xlsx buffer with the 6 terminology columns + one row, for the
 *  uploadExcel multipart test. `all_data_sources: 'Y'` → specific_ds=false,
 *  so no datasource/assistant name resolution is needed (the row imports
 *  cleanly without seeded datasources/assistants). */
async function buildUploadXlsx(
  overrides: Partial<{
    word: string;
    other_words: string;
    description: string;
    datasource: string;
    all_data_sources: string;
  }> = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('terminology');
  ws.columns = [
    { header: '术语名称', key: 'word' },
    { header: '同义词', key: 'other_words' },
    { header: '术语描述', key: 'description' },
    { header: '有效数据源', key: 'datasource' },
    { header: '全部数据源', key: 'all_data_sources' },
    { header: '高级应用', key: 'advanced_application_name' },
  ];
  ws.addRow({
    word: overrides.word ?? '导入术语',
    other_words: overrides.other_words ?? '别名1,别名2',
    description: overrides.description ?? '导入描述',
    datasource: overrides.datasource ?? '',
    all_data_sources: overrides.all_data_sources ?? 'Y',
    advanced_application_name: '',
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('Terminology /system/terminology (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
    prisma = app.get(PrismaService);
    // Clean slate: no terminologies + no audit logs (the @SystemLog e2e PUTs
    // one terminology, which fires an audit CREATE row).
    await prisma.terminology.deleteMany({});
    await prisma.systemLog.deleteMany({});
  });

  afterAll(async () => {
    await prisma.terminology.deleteMany({});
    await prisma.systemLog.deleteMany({});
    await app.close();
  });

  /** Clean all terminology rows (parents + children — deleteMany with an
   *  empty where deletes every row) for count-asserting tests. */
  async function cleanTerminology() {
    await prisma.terminology.deleteMany({});
  }

  /** PUT a terminology (create when no id) + return the created snake row. */
  async function putCreate(
    body: Partial<TerminologySnake> & { word: string },
  ): Promise<TerminologySnake> {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/terminology')
      .set(TOKEN_HEADER, token)
      .send(body);
    expect(res.status).toBe(200);
    // Fetch the row back via the page route (the PUT return is the raw parent
    // row; the page returns the snake shape with derived other_words/names).
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<TerminologyPage>).data;
    return data.data.find((r) => r.word === body.word)!;
  }

  it('GET /system/terminology/page/1/10 without token → 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/terminology/page/1/10',
    );
    expect(res.status).toBe(401);
  });

  it('GET /system/terminology/page/1/10 → {data:[], total_count:0} when empty', async () => {
    await cleanTerminology();
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (res.body as ApiEnvelope<TerminologyPage>).data;
    expect(body.total_count).toBe(0);
    expect(body.data).toEqual([]);
    // §83: full pager shape carried for parity (frontend reads only
    // data + total_count, but the extra fields must be present).
    expect(body.current_page).toBe(1);
    expect(body.page_size).toBe(10);
    expect(body.total_pages).toBe(0);
  });

  it('PUT /system/terminology (no id) → creates parent + children, page shows all 11 snake fields', async () => {
    await cleanTerminology();
    const row = await putCreate({
      word: '收入',
      description: '营收定义',
      other_words: ['营收', 'revenue'],
      specific_ds: false,
      datasource_ids: [],
      enabled: true,
    });
    expect(row).toBeDefined();
    expect(row).toEqual({
      id: expect.any(Number),
      word: '收入',
      description: '营收定义',
      other_words: ['营收', 'revenue'],
      specific_ds: false,
      datasource_ids: [],
      datasource_names: [],
      enabled: true,
      advanced_application: null,
      advanced_application_name: null,
      create_time: expect.any(Number),
    });
  });

  it('PUT /system/terminology (with id) → updates the parent + reconciles children', async () => {
    await cleanTerminology();
    const created = await putCreate({
      word: '成本',
      description: '成本定义',
      other_words: ['支出'],
    });
    // Update: change word + replace other_words.
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/terminology')
      .set(TOKEN_HEADER, token)
      .send({
        id: created.id,
        word: '成本 (已更新)',
        description: '更新后的成本定义',
        other_words: ['支出', '花销'],
        specific_ds: false,
        datasource_ids: [],
        enabled: true,
      });
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<TerminologyPage>).data;
    const updated = data.data.find((r) => r.id === created.id);
    expect(updated).toBeDefined();
    expect(updated!.word).toBe('成本 (已更新)');
    expect(updated!.description).toBe('更新后的成本定义');
    // Children reconciled: old '支出' kept + new '花销' added (order = sent).
    expect(updated!.other_words).toEqual(['支出', '花销']);
  });

  it('DELETE /system/terminology body=[id] → removes parent + children', async () => {
    await cleanTerminology();
    const created = await putCreate({
      word: '删除目标',
      other_words: ['别名'],
    });
    expect(created).toBeDefined();
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/terminology')
      .set(TOKEN_HEADER, token)
      .send([created.id]);
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<TerminologyPage>).data;
    expect(data.total_count).toBe(0);
    // Children also gone (deleteMany WHERE id IN OR pid IN).
    const children = await prisma.terminology.findMany({
      where: { pid: created.id },
    });
    expect(children).toEqual([]);
  });

  it('GET /system/terminology/:id/enable/:enabled → toggles parent + children', async () => {
    await cleanTerminology();
    const created = await putCreate({
      word: '开关术语',
      other_words: ['同义词'],
    });
    // Frontend sends `val + ''` → 'false' path param.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/terminology/${created.id}/enable/false`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<TerminologyPage>).data;
    const row = data.data.find((r) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    // Child also toggled.
    const child = await prisma.terminology.findFirst({
      where: { pid: created.id },
    });
    expect(child?.enabled).toBe(false);
  });

  it('GET /system/terminology/export → xlsx blob (bypasses envelope, xlsx content-type)', async () => {
    await cleanTerminology();
    await putCreate({ word: '导出术语', description: '导出描述' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/export')
      .set(TOKEN_HEADER, token)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('terminology.xlsx');
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('GET /system/terminology/template → xlsx blob (2 example rows + 6 headers)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/template')
      .set(TOKEN_HEADER, token)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('POST /system/terminology/uploadExcel (multipart `file`) → {success_count, ...} envelope-wrapped', async () => {
    await cleanTerminology();
    const buf = await buildUploadXlsx({ word: '上传术语' });
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/terminology/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, { filename: 'test.xlsx' });
    expect(res.status).toBe(200);
    // el-upload does its own XHR + reads `response.data.*`; supertest goes
    // through NestJS so res.body is the full envelope — unwrap to get the
    // summary the handler returned.
    const summary = (
      res.body as ApiEnvelope<{
        success_count: number;
        failed_count: number;
        duplicate_count: number;
        original_count: number;
        error_excel_filename: string | null;
      }>
    ).data;
    expect(summary.success_count).toBeGreaterThanOrEqual(1);
    expect(summary.failed_count).toBe(0);
    expect(summary.original_count).toBe(1);
    expect(summary.error_excel_filename).toBeNull();
    // The imported row actually landed.
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<TerminologyPage>).data;
    expect(data.data.some((r) => r.word === '上传术语')).toBe(true);

    // P2-4: re-importing the SAME file is idempotent — natural-key upsert
    // updates the existing (oid, word) row instead of duplicating it.
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/system/terminology/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, { filename: 'test.xlsx' });
    expect(res2.status).toBe(200);
    const summary2 = (
      res2.body as ApiEnvelope<{
        success_count: number;
        duplicate_count: number;
        original_count: number;
      }>
    ).data;
    expect(summary2.success_count).toBe(1);
    expect(summary2.duplicate_count).toBe(1);
    expect(summary2.original_count).toBe(1);
    const page2 = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10')
      .set(TOKEN_HEADER, token);
    const data2 = (page2.body as ApiEnvelope<TerminologyPage>).data;
    expect(data2.data.filter((r) => r.word === '上传术语')).toHaveLength(1);
  });

  it('failed import rows produce a downloadable error workbook', async () => {
    const buf = await buildUploadXlsx({
      word: `缺失数据源术语_${Date.now()}`,
      datasource: '不存在的数据源',
      all_data_sources: 'N',
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/terminology/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, { filename: 'bad.xlsx' });
    expect(res.status).toBe(200);
    const summary = (
      res.body as ApiEnvelope<{
        failed_count: number;
        error_excel_filename: string | null;
      }>
    ).data;
    expect(summary.failed_count).toBe(1);
    expect(summary.error_excel_filename).toMatch(/_error\.xlsx$/);

    const download = await request(app.getHttpServer())
      .post('/api/v1/system/download-fail-info')
      .set(TOKEN_HEADER, token)
      .send({ file: summary.error_excel_filename });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('GET /system/terminology/page/1/10?word=收入 → filters by keyword (parent word contains)', async () => {
    await cleanTerminology();
    await putCreate({ word: '收入', description: '营收' });
    await putCreate({ word: '成本', description: '支出' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10?word=收入')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<TerminologyPage>).data;
    expect(data.total_count).toBe(1);
    expect(data.data[0].word).toBe('收入');
  });

  it('GET /system/terminology/page/1/10?ds_list=1&ds_list=2 → repeated params filter (specific_ds=false matches all)', async () => {
    await cleanTerminology();
    // Term A: global (specific_ds=false → matches any ds_list).
    await putCreate({
      word: '全局术语',
      specific_ds: false,
      datasource_ids: [],
    });
    // Term B: specific to datasource 1 (datasource_ids=[1] → matches ds_list=1).
    await putCreate({
      word: '特定术语',
      specific_ds: true,
      datasource_ids: [1],
    });
    // ds_list=1 → both match (A via specific_ds=false, B via intersection).
    const res1 = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10?ds_list=1')
      .set(TOKEN_HEADER, token);
    expect(res1.status).toBe(200);
    const data1 = (res1.body as ApiEnvelope<TerminologyPage>).data;
    expect(data1.total_count).toBe(2);
    // ds_list=2 → only A matches (B's [1] doesn't intersect [2]).
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/system/terminology/page/1/10?ds_list=2')
      .set(TOKEN_HEADER, token);
    expect(res2.status).toBe(200);
    const data2 = (res2.body as ApiEnvelope<TerminologyPage>).data;
    expect(data2.total_count).toBe(1);
    expect(data2.data[0].word).toBe('全局术语');
  });

  it('@SystemLog write→read: PUT /system/terminology → GET /system/audit/page → row appears with module=terminology + oid/ip captured', async () => {
    await cleanTerminology();
    await prisma.systemLog.deleteMany({});
    // PUT a terminology — its @SystemLog(CREATE) fires the interceptor → record().
    const createRes = await request(app.getHttpServer())
      .put('/api/v1/system/terminology')
      .set(TOKEN_HEADER, token)
      .send({ word: '审计术语', description: '审计追踪', other_words: [] });
    expect(createRes.status).toBe(200);
    // batch7: bounded poll instead of a fixed 100ms sleep — record() is
    // fire-and-forget, so poll (≤1s) until an audit row from THIS test
    // (create_time >= test start) lands; the final response flows into the
    // assertions below for a loud failure message.
    const res = await waitFor(
      async () =>
        await request(app.getHttpServer())
          .get('/api/v1/system/audit/page/1/10')
          .set(TOKEN_HEADER, token),
      (r) =>
        r.status === 200 &&
        (
          (r.body as ApiEnvelope<{ data: { create_time: number }[] }>).data
            ?.data ?? []
        ).some((row) => row.create_time >= startedAt),
    );
    expect(res.status).toBe(200);
    interface AuditLogSnake {
      id: string;
      operation_type_name: string;
      operation_detail_info: string;
      user_name: string;
      resource_name: string;
      operation_status: 'success' | 'failed';
      ip_address: string | null;
      create_time: number;
      oid: string;
      oid_name: string;
    }
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBeGreaterThanOrEqual(1);
    const createRow = body.data.find((r) => r.operation_type_name === 'Create');
    expect(createRow).toBeDefined();
    // §104 write-side capture: oid + ip_address populated from the request.
    expect(createRow!.oid).toBe('1');
    expect(createRow!.oid_name).toBe('default');
    expect(createRow!.ip_address).toBeTruthy();
    expect(createRow!.user_name).toBe('admin');
    expect(createRow!.operation_status).toBe('success');
    // The @SystemLog resources callback snapshot carries the term's word.
    expect(createRow!.resource_name).toBe('审计术语');
  });
  const startedAt = Date.now();
});
