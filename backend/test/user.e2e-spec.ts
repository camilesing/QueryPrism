// User e2e — Phase 10 §85/§88. Covers all 18 routes of the rewritten
// user.controller against the real AppModule + real Prisma:
//   - mgmt pager returns {items, total} with snake_case rows (oid_list derived
//     from the UserWs include, create_time/update_time ISO, Int status/origin)
//   - mgmt CRUD (POST/PUT/PATCH/DELETE) returns snake_case via toUserSnake
//   - self-service routes (GET /ws, PUT /language, PUT /pwd, PUT /ws/:oid)
//     use @CurrentUser rather than :id path params
//   - PATCH /user/pwd/:id resets to the default password ('123456'); GET
//     /user/defaultPwd returns the same constant
//   - batchImport (multipart xlsx) returns {successCount, errorCount, dataKey};
//     failed rows produce a downloadable + clearable error workbook
//
// Each test creates users with a timestamp-suffixed account so the suite is
// order-independent and doesn't collide with the seed admin or prior runs.
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
  msg: string;
  data: T;
}

interface UserSnake {
  id: number;
  account: string;
  name: string | null;
  email: string | null;
  oid: number;
  oid_list: number[];
  status: number;
  origin: number;
  language: string;
  system_variables: unknown;
  create_time: string;
  update_time: string;
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

/** Build a 2-row xlsx (header + one data row) for the batchImport multipart
 *  upload. The account is timestamp-suffixed so it never collides. */
async function buildImportXlsx(account: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('users');
  ws.columns = [
    { header: 'account', key: 'account', width: 20 },
    { header: 'password', key: 'password', width: 20 },
    { header: 'email', key: 'email', width: 30 },
    { header: 'language', key: 'language', width: 12 },
    { header: 'oid', key: 'oid', width: 8 },
  ];
  ws.addRow({
    account,
    password: 'Imp1234!',
    email: 'imp@example.com',
    language: 'zh-CN',
    oid: 1,
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('User mgmt + self-service (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const stamp = Date.now();
  const unique = (n: string) => `u_${stamp}_${n}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── self-service (admin, pristine) ───────────────────────────────────

  it('GET /user/info returns camelCase UserInfo (9b auth shape, not snake)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<Record<string, unknown>>;
    expect(body.code).toBe(0);
    expect(body.data.account).toBe('admin');
    expect(body.data.name).toBe('admin');
    expect(typeof body.data.id).toBe('number');
    expect(typeof body.data.oid).toBe('number');
    expect(typeof body.data.origin).toBe('number');
    expect(typeof body.data.exp).toBe('number');
  });

  it('GET /user/ws returns [{id, name}] workspace options', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/ws')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{ id: number; name: string }[]>;
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.data[0].id).toBe('number');
    expect(typeof body.data[0].name).toBe('string');
    expect(body.data.some((w) => w.name === 'default')).toBe(true);
  });

  it('PUT /user/ws/:oid switches to a member workspace (admin→default 1)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/user/ws/1')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  it('PUT /user/ws/:oid 404s for a non-member workspace', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/user/ws/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  // ─── mgmt stubs ───────────────────────────────────────────────────────

  it('GET /user/defaultPwd returns the default password string', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/defaultPwd')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<string>;
    expect(body.code).toBe(0);
    expect(body.data).toBe('123456');
  });

  it('GET /user/template downloads an xlsx blob', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/template')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/user-template\.xlsx/);
    // supertest exposes the binary body via res.text (latin1) — assert it's
    // non-empty (the xlsx zip starts with the PK magic bytes 0x50 0x4b).
    expect((res.text ?? '').length).toBeGreaterThan(0);
  });

  it('GET /user/errorRecord/:key 404s for an unknown key', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/errorRecord/none')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  it('GET /user/clearErrorRecord/:key is idempotent', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/clearErrorRecord/none')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  // ─── mgmt pager ({items, total} + snake) ──────────────────────────────

  it('GET /user/pager/:n/:s returns {items, total} with snake_case rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/user/pager/1/20')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{ items: UserSnake[]; total: number }>;
    expect(body.code).toBe(0);
    expect(typeof body.data.total).toBe('number');
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items.length).toBeGreaterThan(0);
    const u = body.data.items[0];
    // snake fields present
    expect(typeof u.id).toBe('number');
    expect(typeof u.account).toBe('string');
    expect(Array.isArray(u.oid_list)).toBe(true);
    expect(typeof u.status).toBe('number');
    expect(typeof u.origin).toBe('number');
    expect(typeof u.create_time).toBe('string');
    expect(typeof u.update_time).toBe('string');
    // camelCase fields absent
    expect((u as unknown as Record<string, unknown>).createdAt).toBeUndefined();
    expect(
      (u as unknown as Record<string, unknown>).systemVariables,
    ).toBeUndefined();
  });

  // ─── mgmt CRUD (snake) ────────────────────────────────────────────────

  let userA: UserSnake;
  let userB: UserSnake;
  let userC: UserSnake;

  it('POST /user creates a user and returns snake_case', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: unique('A'),
        password: 'Init1234!',
        email: 'a@example.com',
        name: 'User A',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<UserSnake>;
    expect(body.code).toBe(0);
    userA = body.data;
    expect(userA.account).toBe(unique('A'));
    expect(userA.name).toBe('User A');
    expect(userA.oid).toBe(1);
    expect(userA.oid_list).toEqual([1]);
    expect(userA.status).toBe(1);
    expect(userA.origin).toBe(0);
    expect(userA.language).toBe('zh-CN');
    expect(typeof userA.create_time).toBe('string');
  });

  it('GET /user/:key returns the snake_case user', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/user/${userA.id}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<UserSnake>;
    expect(body.data.id).toBe(userA.id);
    expect(body.data.account).toBe(userA.account);
    expect(body.data.oid_list).toEqual([1]);
  });

  it('PUT /user (body with id) updates + returns snake_case', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({ id: userA.id, name: 'User A Renamed', email: 'a2@example.com' });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<UserSnake>;
    expect(body.data.name).toBe('User A Renamed');
    expect(body.data.email).toBe('a2@example.com');
  });

  it('PUT /user 400s when id is missing from the body', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no id' });
    expect(res.status).toBe(400);
  });

  it('PATCH /user/status (body {id, status}) toggles + returns snake', async () => {
    // disable
    const off = await request(app.getHttpServer())
      .patch('/api/v1/user/status')
      .set(TOKEN_HEADER, token)
      .send({ id: userA.id, status: 0 });
    expect(off.status).toBe(200);
    expect((off.body as ApiEnvelope<UserSnake>).data.status).toBe(0);
    // re-enable so the password-reset tests below can log in as userA
    // (auth.service rejects status !== 1).
    const on = await request(app.getHttpServer())
      .patch('/api/v1/user/status')
      .set(TOKEN_HEADER, token)
      .send({ id: userA.id, status: 1 });
    expect(on.status).toBe(200);
    expect((on.body as ApiEnvelope<UserSnake>).data.status).toBe(1);
  });

  it('PATCH /user/pwd/:id resets to the default password', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/user/pwd/${userA.id}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // the default password ('123456') now logs the user in
    const loginRes = await login(app, userA.account, '123456');
    expect(typeof loginRes).toBe('string');
    // the old password no longer works
    const oldLogin = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: userA.account, password: 'Init1234!' });
    expect(oldLogin.status).toBe(401);
  });

  it('PUT /user/pwd (self) changes the password with {pwd, new_pwd}', async () => {
    const userToken = await login(app, userA.account, '123456');
    const res = await request(app.getHttpServer())
      .put('/api/v1/user/pwd')
      .set(TOKEN_HEADER, userToken)
      .send({ pwd: '123456', new_pwd: 'NewTest1!' });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // new password works
    const newToken = await login(app, userA.account, 'NewTest1!');
    expect(typeof newToken).toBe('string');
    // old password fails
    const oldLogin = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: userA.account, password: '123456' });
    expect(oldLogin.status).toBe(401);
  });

  it('PUT /user/pwd (self) 400s on a wrong old password', async () => {
    const userToken = await login(app, userA.account, 'NewTest1!');
    const res = await request(app.getHttpServer())
      .put('/api/v1/user/pwd')
      .set(TOKEN_HEADER, userToken)
      .send({ pwd: 'wrong-old-pwd', new_pwd: 'Another1!' });
    expect(res.status).toBe(400);
  });

  it('PUT /user/language (self) updates the current user language', async () => {
    const userToken = await login(app, userA.account, 'NewTest1!');
    const res = await request(app.getHttpServer())
      .put('/api/v1/user/language')
      .set(TOKEN_HEADER, userToken)
      .send({ language: 'en' });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  it('POST /user/batchImport (multipart) returns {successCount, errorCount, dataKey}', async () => {
    const buf = await buildImportXlsx(unique('imp'));
    const res = await request(app.getHttpServer())
      .post('/api/v1/user/batchImport')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, 'users.xlsx');
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{
      successCount: number;
      errorCount: number;
      dataKey: string | null;
    }>;
    expect(body.code).toBe(0);
    expect(body.data.successCount).toBe(1);
    expect(body.data.errorCount).toBe(0);
    expect(body.data.dataKey).toBeNull();
  });

  it('batchImport writes an error record and serves it until cleared', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('users');
    ws.columns = [
      { header: 'account', key: 'account', width: 20 },
      { header: 'password', key: 'password', width: 20 },
      { header: 'email', key: 'email', width: 30 },
      { header: 'language', key: 'language', width: 12 },
      { header: 'oid', key: 'oid', width: 8 },
    ];
    // row 1: missing account; row 2: missing password
    ws.addRow({
      account: '',
      password: 'x',
      email: '',
      language: 'zh-CN',
      oid: 1,
    });
    ws.addRow({
      account: unique('bad'),
      password: '',
      email: '',
      language: 'zh-CN',
      oid: 1,
    });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await request(app.getHttpServer())
      .post('/api/v1/user/batchImport')
      .set(TOKEN_HEADER, token)
      .attach('file', buf, 'users.xlsx');
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<{
      successCount: number;
      errorCount: number;
      dataKey: string | null;
    }>;
    expect(body.data.successCount).toBe(0);
    expect(body.data.errorCount).toBe(2);
    expect(body.data.dataKey).toMatch(/^user_.*_error\.xlsx$/);

    const key = body.data.dataKey as string;
    const download = await request(app.getHttpServer())
      .get(`/api/v1/user/errorRecord/${key}`)
      .set(TOKEN_HEADER, token);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/spreadsheetml/);

    const cleared = await request(app.getHttpServer())
      .get(`/api/v1/user/clearErrorRecord/${key}`)
      .set(TOKEN_HEADER, token);
    expect(cleared.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get(`/api/v1/user/errorRecord/${key}`)
      .set(TOKEN_HEADER, token);
    expect(after.status).toBe(404);
  });

  it('POST /user/batchImport 400s without a file', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/user/batchImport')
      .set(TOKEN_HEADER, token);
    // multipart with no file → FileInterceptor yields no file → 400.
    expect(res.status).toBe(400);
  });

  it('DELETE /user (batch body {ids}) removes multiple users', async () => {
    // create B + C
    const createB = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: unique('B'),
        password: 'Init1234!',
        oid: 1,
        oid_list: [1],
      });
    userB = (createB.body as ApiEnvelope<UserSnake>).data;
    const createC = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: unique('C'),
        password: 'Init1234!',
        oid: 1,
        oid_list: [1],
      });
    userC = (createC.body as ApiEnvelope<UserSnake>).data;

    const res = await request(app.getHttpServer())
      .delete('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({ ids: [userB.id, userC.id] });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    // confirm gone
    const goneB = await request(app.getHttpServer())
      .get(`/api/v1/user/${userB.id}`)
      .set(TOKEN_HEADER, token);
    expect(goneB.status).toBe(400); // getOne 400s on missing
  });

  it('DELETE /user/:key removes a single user', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/user/${userA.id}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });
});
