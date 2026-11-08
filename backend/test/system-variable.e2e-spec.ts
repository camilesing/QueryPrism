// system-variable e2e — Phase 10c cycle 2 §82/§88/§91/§101. Covers the 4
// action-style POST /sys_variable routes + the 401 guard + name-uniqueness
// 400 + the polymorphic listAll/listPage filter (system vars excluded from
// name searches). The 3 seeded system vars (Name/Account/Email, ids 1-3,
// type=system) are non-deletable from the UI but the backend doesn't enforce
// (the frontend variables/index.vue:33 hardcodes
// `![1,2,3].includes(row.id)` + :90 early-returns on `type === 'system'`).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface SysVariableSnake {
  id: number;
  name: string;
  var_type: string;
  value: unknown;
  type: string;
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

describe('SystemVariable /sys_variable (e2e)', () => {
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

    // Clean up any custom vars left from prior runs (system vars stay).
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listAll')
      .set(TOKEN_HEADER, token)
      .send({});
    const all = (res.body as ApiEnvelope<SysVariableSnake[]>).data ?? [];
    for (const v of all) {
      if (v.type === 'custom') {
        await request(app.getHttpServer())
          .post('/api/v1/sys_variable/delete')
          .set(TOKEN_HEADER, token)
          .send([v.id]);
      }
    }
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await request(app.getHttpServer())
        .post('/api/v1/sys_variable/delete')
        .set(TOKEN_HEADER, token)
        .send([id]);
    }
    await app.close();
  });

  it('POST /sys_variable/listAll without token → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listAll')
      .send({});
    expect(res.status).toBe(401);
  });

  it('POST /sys_variable/listAll {} → bare array with 3 seeded system vars (Name/Account/Email)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listAll')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<SysVariableSnake[]>).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);
    const names = data.map((v) => v.name).sort();
    expect(names).toEqual(['Account', 'Email', 'Name']);
    // All system, var_type text, value arrays.
    for (const v of data) {
      expect(v.type).toBe('system');
      expect(v.var_type).toBe('text');
      expect(Array.isArray(v.value)).toBe(true);
    }
    // Spot-check the 'Name' var maps to the user 'name' field.
    const nameVar = data.find((v) => v.name === 'Name');
    expect(nameVar?.value).toEqual(['name']);
  });

  it('POST /sys_variable/listPage/1/10 {} → {items: 3 system vars, total: 3}', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: SysVariableSnake[];
        total: number;
      }>
    ).data;
    expect(data.total).toBe(3);
    expect(data.items).toHaveLength(3);
  });

  it('POST /sys_variable/listPage/1/10 {name:"Name"} → {items: [], total: 0} (system vars excluded from name search)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({ name: 'Name' });
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: SysVariableSnake[];
        total: number;
      }>
    ).data;
    expect(data.total).toBe(0);
    expect(data.items).toEqual([]);
  });

  it('POST /sys_variable/save create → {success}; re-listPage shows 4 total; custom var has type=custom', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/save')
      .set(TOKEN_HEADER, token)
      .send({ name: 'test_var', var_type: 'text', value: ['a', 'b'] });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    const list = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({});
    const data = (
      list.body as ApiEnvelope<{
        items: SysVariableSnake[];
        total: number;
      }>
    ).data;
    expect(data.total).toBe(4);
    const custom = data.items.find((v) => v.name === 'test_var');
    expect(custom).toBeDefined();
    expect(custom?.type).toBe('custom');
    expect(custom?.var_type).toBe('text');
    expect(custom?.value).toEqual(['a', 'b']);
    createdIds.push(custom!.id);
  });

  it('POST /sys_variable/save duplicate name → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/save')
      .set(TOKEN_HEADER, token)
      .send({ name: 'test_var', var_type: 'text', value: ['x'] });
    expect(res.status).toBe(400);
  });

  it('POST /sys_variable/listAll {name:"test"} → [the custom var] (type != system, name contains)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listAll')
      .set(TOKEN_HEADER, token)
      .send({ name: 'test' });
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<SysVariableSnake[]>).data;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('test_var');
    expect(data[0].type).toBe('custom');
  });

  it('POST /sys_variable/save update {id, name, var_type, value} → {success}; re-listPage reflects changes', async () => {
    const id = createdIds[createdIds.length - 1];
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/save')
      .set(TOKEN_HEADER, token)
      .send({
        id,
        name: 'test_var_upd',
        var_type: 'number',
        value: [1, 100],
      });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    const list = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({});
    const data = (
      list.body as ApiEnvelope<{
        items: SysVariableSnake[];
        total: number;
      }>
    ).data;
    const updated = data.items.find((v) => v.id === id);
    expect(updated?.name).toBe('test_var_upd');
    expect(updated?.var_type).toBe('number');
    expect(updated?.value).toEqual([1, 100]);
    // type stays custom (server doesn't change type on update).
    expect(updated?.type).toBe('custom');
  });

  it('POST /sys_variable/delete [id] → {success}; re-listPage shows total back to 3 (system vars remain)', async () => {
    const before = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({});
    const beforeTotal = (before.body as ApiEnvelope<{ total: number }>).data
      .total;

    const id = createdIds[createdIds.length - 1];
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/delete')
      .set(TOKEN_HEADER, token)
      .send([id]);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    const after = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/listPage/1/10')
      .set(TOKEN_HEADER, token)
      .send({});
    const afterData = (
      after.body as ApiEnvelope<{
        items: SysVariableSnake[];
        total: number;
      }>
    ).data;
    expect(afterData.total).toBe(beforeTotal - 1);
    // The 3 system vars remain.
    expect(afterData.items.filter((v) => v.type === 'system')).toHaveLength(3);
    // Remove from createdIds so afterAll doesn't re-delete.
    const idx = createdIds.indexOf(id);
    if (idx >= 0) createdIds.splice(idx, 1);
  });

  it('POST /sys_variable/delete [] (empty array) → {success} (no-op, idempotent)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sys_variable/delete')
      .set(TOKEN_HEADER, token)
      .send([]);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });
});
