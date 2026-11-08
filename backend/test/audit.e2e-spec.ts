// audit e2e — Phase 10c cycle 3 §82/§83/§88/§101/§104. Covers the 3 read-only
// GET /system/audit routes + the 401 guard + the `__`-joined multi-value query
// filter + the xlsx blob export + a full-pipeline @SystemLog write→read
// round-trip. The audit module is read-only (no create/update/delete routes);
// rows are written by the SystemLogInterceptor as a side-effect of other
// modules' @SystemLog-decorated handlers, so the e2e seeds rows directly via
// prisma for deterministic field assertions + via an apikey POST for the
// end-to-end write-path check.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { waitFor } from './helpers/wait-for';
import { PrismaService } from './../src/database/prisma.service';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface AuditLogSnake {
  id: string;
  operation_type_name: string;
  operation_detail_info: string;
  user_name: string;
  resource_name: string;
  operation_status: 'success' | 'failed';
  operation_status_name: string;
  ip_address: string | null;
  create_time: number;
  oid_name: string;
  oid: string;
  error_message: string;
  remark: string;
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

describe('Audit /system/audit (e2e)', () => {
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
    // Clean slate: no audit logs + no apikeys (the @SystemLog e2e POSTs one).
    await prisma.systemLog.deleteMany({});
    await prisma.apiKey.deleteMany({});
  });

  afterAll(async () => {
    await prisma.systemLog.deleteMany({});
    await prisma.apiKey.deleteMany({});
    await app.close();
  });

  /** Insert a fully-populated SystemLog row (all §104 fields set) for the
   *  read-path field-assertion tests. */
  async function insertFullRow(
    overrides: Partial<{
      type: string;
      status: string;
      detail: string;
      oid: number | null;
    }> = {},
  ): Promise<number> {
    const created = await prisma.systemLog.create({
      data: {
        module: 'api_key',
        type: overrides.type ?? 'create',
        status: overrides.status ?? 'success',
        operatorId: 1,
        operator: 'admin',
        detail: overrides.detail ?? '新建API密钥',
        oid: overrides.oid ?? 1,
        ipAddress: '127.0.0.1',
        userAgent: 'jest/supertest',
        executionTime: 42,
        errorMessage: null,
        requestMethod: 'POST',
        requestPath: '/api/v1/system/apikey',
        remark: null,
        resources: { create: [{ name: 'test-key', originId: '1' }] },
      },
    });
    return created.id;
  }

  it('GET /system/audit/page/1/10 without token → 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/audit/page/1/10',
    );
    expect(res.status).toBe(401);
  });

  it('GET /system/audit/get_options → [{id, name}] operation-type array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/get_options')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const arr = (res.body as ApiEnvelope<{ id: string; name: string }[]>).data;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    const ids = arr.map((o) => o.id);
    expect(ids).toContain('create');
    expect(ids).toContain('login');
    // every option has both fields + name is capitalized display
    for (const o of arr) {
      expect(typeof o.id).toBe('string');
      expect(typeof o.name).toBe('string');
      expect(o.name).toBe(o.id.charAt(0).toUpperCase() + o.id.slice(1));
    }
  });

  it('GET /system/audit/page/1/10 {} → {data:[], total_count:0} when empty', async () => {
    await prisma.systemLog.deleteMany({});
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/page/1/10')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    // §83: page returns {data:[...], total_count} as the unwrapped inner object
    // (envelope wraps → {success,code,msg,data:{data:[...],total_count}} →
    // frontend unwraps the outer data → {data:[...],total_count}).
    const body = (
      res.body as ApiEnvelope<{
        data: AuditLogSnake[];
        total_count: number;
      }>
    ).data;
    expect(body.total_count).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('GET /system/audit/page/1/10 → {data:[row], total_count:1} with all 12 snake fields', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow();
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/page/1/10')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBe(1);
    expect(body.data.length).toBe(1);
    const row = body.data[0];
    expect(row).toEqual({
      id: expect.any(String),
      operation_type_name: 'Create',
      operation_detail_info: '新建API密钥',
      user_name: 'admin',
      resource_name: 'test-key',
      operation_status: 'success',
      operation_status_name: 'Success',
      ip_address: '127.0.0.1',
      create_time: expect.any(Number),
      oid_name: 'default',
      oid: '1',
      error_message: '',
      remark: '',
    });
  });

  it('GET /system/audit/page/1/10?name=API → matches by keyword (detail contains)', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow({ detail: '新建API密钥' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/page/1/10?name=API')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBe(1);
    expect(body.data[0].operation_detail_info).toContain('API');
  });

  it('GET /system/audit/page/1/10?opt_type_list=create__delete → filters by type IN', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow({ type: 'create' });
    await insertFullRow({ type: 'update' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/page/1/10?opt_type_list=create__delete')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBe(1);
    expect(body.data[0].operation_type_name).toBe('Create');
  });

  it('GET /system/audit/page/1/10?log_status=failed → filters by status IN', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow({ status: 'success' });
    await insertFullRow({ status: 'failed' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/page/1/10?log_status=failed')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBe(1);
    expect(body.data[0].operation_status).toBe('failed');
  });

  it('GET /system/audit/page/1/10?time_range=<now-1h>__<now+1h> → filters by createdAt BETWEEN', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow();
    const now = Date.now();
    const start = now - 60 * 60 * 1000; // 1h ago
    const end = now + 60 * 60 * 1000; // 1h ahead
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/audit/page/1/10?time_range=${start}__${end}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = (
      res.body as ApiEnvelope<{ data: AuditLogSnake[]; total_count: number }>
    ).data;
    expect(body.total_count).toBe(1);
  });

  it('GET /system/audit/export → xlsx blob (bypasses envelope, xlsx content-type)', async () => {
    await prisma.systemLog.deleteMany({});
    await insertFullRow();
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/audit/export')
      .set(TOKEN_HEADER, token)
      .buffer(true);
    expect(res.status).toBe(200);
    const ct = res.headers['content-type'];
    expect(ct).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const cd = res.headers['content-disposition'];
    expect(cd).toContain('attachment');
    expect(cd).toContain('system_log.xlsx');
    // Non-empty body — express sets Content-Length for the sent Buffer (same
    // assertion chat.e2e-spec uses for its xlsx exportRecord route).
    expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
  });

  it('@SystemLog write→read end-to-end: POST /system/apikey → GET /system/audit/page → row appears with oid/ip captured', async () => {
    await prisma.systemLog.deleteMany({});
    // POST an apikey — its @SystemLog(CREATE) fires the interceptor → record().
    const startedAt = Date.now();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token)
      .send({});
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
  });
});
