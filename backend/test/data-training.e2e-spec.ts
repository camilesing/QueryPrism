// data-training e2e — Phase 10c cycle 5 §82/§83/§88/§91/§92/§100/§104/§105.
// Covers the 7 /system/data-training routes + the 401 guard + the single
// `question` keyword filter (on question AND description) + the xlsx blob
// export/template + the multipart uploadExcel + a full-pipeline @SystemLog
// write→read round-trip. Mirrors cycle 4 terminology e2e's setup
// (X-QUERYPRISM-TOKEN header, api/v1 prefix, beforeAll/afterAll cleanup,
// fire-and-forget 100ms wait for the audit record()). No pid/other_words here
// (data-training is flat — simpler than terminology).
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

interface DataTrainingSnake {
  id: number;
  oid: number;
  datasource: number | null;
  datasource_name: string | null;
  question: string;
  description: string | null;
  enabled: boolean;
  advanced_application: number | null;
  advanced_application_name: string | null;
  create_time: number;
}

interface DataTrainingPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: DataTrainingSnake[];
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

/** Build an xlsx buffer with the 4 data-training columns + one row,
 *  for the uploadExcel multipart test. Empty datasource/advanced names →
 *  null resolution (the row imports cleanly without seeded rows, same shape
 *  as terminology's `all_data_sources:'Y'` upload). */
async function buildUploadXlsx(
  overrides: Partial<{
    question: string;
    description: string;
    datasource_name: string;
    advanced_application_name: string;
  }> = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data_training');
  ws.columns = [
    { header: '问题表述', key: 'question' },
    { header: '示例SQL', key: 'description' },
    { header: '生效数据源', key: 'datasource_name' },
    { header: '高级应用', key: 'advanced_application_name' },
  ];
  ws.addRow({
    question: overrides.question ?? '上传样例',
    description: overrides.description ?? 'SELECT 1',
    datasource_name: overrides.datasource_name ?? '',
    advanced_application_name: overrides.advanced_application_name ?? '',
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('DataTraining /system/data-training (e2e)', () => {
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
    // Clean slate: no data-training rows + no audit logs (the @SystemLog e2e
    // PUTs one row, which fires an audit CREATE row).
    await prisma.dataTraining.deleteMany({});
    await prisma.systemLog.deleteMany({});
  });

  afterAll(async () => {
    await prisma.dataTraining.deleteMany({});
    await prisma.systemLog.deleteMany({});
    await app.close();
  });

  /** Clean all data-training rows for count-asserting tests. */
  async function cleanRows() {
    await prisma.dataTraining.deleteMany({});
  }

  /** PUT a data-training row (create when no id) + return the created snake
   *  row via the page route (the PUT return is the raw row; the page returns
   *  the snake shape with derived datasource_name/advanced_application_name). */
  async function putCreate(
    body: Partial<DataTrainingInfo> & { question: string },
  ): Promise<DataTrainingSnake> {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/data-training')
      .set(TOKEN_HEADER, token)
      .send(body);
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<DataTrainingPage>).data;
    return data.data.find((r) => r.question === body.question)!;
  }

  // Reuse the service's body interface shape for the PUT helper.
  interface DataTrainingInfo {
    id?: number;
    datasource?: number | null;
    question?: string;
    description?: string;
    enabled?: boolean;
    advanced_application?: number | null;
  }

  it('GET /system/data-training/page/1/10 without token → 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/data-training/page/1/10',
    );
    expect(res.status).toBe(401);
  });

  it('GET /system/data-training/page/1/10 → {data:[], total_count:0} when empty', async () => {
    await cleanRows();
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (res.body as ApiEnvelope<DataTrainingPage>).data;
    expect(body.total_count).toBe(0);
    expect(body.data).toEqual([]);
    // §83: full pager shape carried for parity.
    expect(body.current_page).toBe(1);
    expect(body.page_size).toBe(10);
    expect(body.total_pages).toBe(0);
  });

  it('PUT /system/data-training (no id) → creates row, page shows all 10 snake fields', async () => {
    await cleanRows();
    const row = await putCreate({
      question: 'how many orders?',
      description: 'SELECT count(*) FROM orders',
      datasource: null,
      enabled: true,
    });
    expect(row).toBeDefined();
    expect(row).toEqual({
      id: expect.any(Number),
      oid: 1,
      datasource: null,
      datasource_name: null,
      question: 'how many orders?',
      description: 'SELECT count(*) FROM orders',
      enabled: true,
      advanced_application: null,
      advanced_application_name: null,
      create_time: expect.any(Number),
    });
  });

  it('PUT /system/data-training (with id) → updates the row', async () => {
    await cleanRows();
    const created = await putCreate({
      question: 'top products',
      description: 'SELECT * FROM products',
    });
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/data-training')
      .set(TOKEN_HEADER, token)
      .send({
        id: created.id,
        question: 'top products (updated)',
        description: 'SELECT name FROM products LIMIT 10',
        datasource: null,
        enabled: true,
      });
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<DataTrainingPage>).data;
    const updated = data.data.find((r) => r.id === created.id);
    expect(updated).toBeDefined();
    expect(updated!.question).toBe('top products (updated)');
    expect(updated!.description).toBe('SELECT name FROM products LIMIT 10');
  });

  it('DELETE /system/data-training body=[id] → removes the row', async () => {
    await cleanRows();
    const created = await putCreate({
      question: 'delete target',
      description: 'SELECT 1',
    });
    expect(created).toBeDefined();
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/data-training')
      .set(TOKEN_HEADER, token)
      .send([created.id]);
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<DataTrainingPage>).data;
    expect(data.total_count).toBe(0);
  });

  it('GET /system/data-training/:id/enable/:enabled → toggles enabled', async () => {
    await cleanRows();
    const created = await putCreate({
      question: 'toggle target',
      description: 'SELECT 1',
    });
    // Frontend sends `val + ''` → 'false' path param.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/data-training/${created.id}/enable/false`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<DataTrainingPage>).data;
    const row = data.data.find((r) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
  });

  it('GET /system/data-training/export → xlsx blob (bypasses envelope, xlsx content-type)', async () => {
    await cleanRows();
    await putCreate({ question: 'export target', description: 'SELECT 1' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/export')
      .set(TOKEN_HEADER, token)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('data-training.xlsx');
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('GET /system/data-training/template → xlsx blob (1 sample row + 4 headers)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/template')
      .set(TOKEN_HEADER, token)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('POST /system/data-training/uploadExcel (multipart `file`) → {success_count, ...} envelope-wrapped', async () => {
    await cleanRows();
    const buf = await buildUploadXlsx({ question: '上传样例' });
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/data-training/uploadExcel')
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
    // Deviation §105: error-file generation deferred → always null.
    expect(summary.error_excel_filename).toBeNull();
    // The imported row actually landed.
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10')
      .set(TOKEN_HEADER, token);
    const data = (page.body as ApiEnvelope<DataTrainingPage>).data;
    expect(data.data.some((r) => r.question === '上传样例')).toBe(true);
  });

  it('GET /system/data-training/page/1/10?question=orders → filters by question contains', async () => {
    await cleanRows();
    await putCreate({ question: 'how many orders?', description: 'count' });
    await putCreate({ question: 'top products', description: 'list' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10?question=orders')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<DataTrainingPage>).data;
    expect(data.total_count).toBe(1);
    expect(data.data[0].question).toBe('how many orders?');
  });

  it('GET /system/data-training/page/1/10?question=count → filters by description contains', async () => {
    await cleanRows();
    await putCreate({ question: 'q1', description: 'count orders' });
    await putCreate({ question: 'q2', description: 'list products' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/data-training/page/1/10?question=count')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<DataTrainingPage>).data;
    expect(data.total_count).toBe(1);
    expect(data.data[0].question).toBe('q1');
  });

  it('@SystemLog write→read: PUT /system/data-training → GET /system/audit/page → row appears with module=data_training + oid/ip captured', async () => {
    await cleanRows();
    await prisma.systemLog.deleteMany({});
    // PUT a row — its @SystemLog(CREATE) fires the interceptor → record().
    const createRes = await request(app.getHttpServer())
      .put('/api/v1/system/data-training')
      .set(TOKEN_HEADER, token)
      .send({ question: '审计样例', description: 'audit trail' });
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
    // The @SystemLog resources callback snapshot carries the question.
    expect(createRow!.resource_name).toBe('审计样例');
  });
  const startedAt = Date.now();
});
