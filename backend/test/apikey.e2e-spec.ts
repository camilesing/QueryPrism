// apikey e2e — Phase 10c cycle 1 §82/§88/§91/§99 + 2026-09 review P0-2.
// Covers the 5 /system/apikey routes + the 401 guard + the max-5-keys cap +
// ownership 404s. Secret contract (review P0-2): the key is created at rest
// AES-256-GCM-encrypted, the LIST masks secret_key to '' (no bulk plaintext),
// and the plaintext is only revealed one key at a time via
// GET /system/apikey/:id/secret (ownership-scoped).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface ApiKeySnake {
  id: number;
  access_key: string;
  secret_key: string;
  status: boolean;
  create_time: number;
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
  expect(res.status).toBe(200); // 2026-09 review test hygiene: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('ApiKey (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let otherToken: string;
  let otherUserId: number;
  let firstId: number | undefined;

  /** batch7: order-independence — tests that consume firstId provision it on
   *  demand instead of relying on the create test having run before them. */
  const ensureFirstId = async (): Promise<number> => {
    if (firstId === undefined) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/system/apikey')
        .set(TOKEN_HEADER, token)
        .send({});
      if (res.status !== 200) {
        throw new Error(`provisioning a key failed: HTTP ${res.status}`);
      }
      firstId = (res.body as ApiEnvelope<{ id: number }>).data.id;
      createdIds.push(firstId);
    }
    return firstId;
  };
  const createdIds: number[] = [];
  const otherAccount = `e2e-apikey-other-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);

    token = await login(app);

    // A second user for the ownership-404 reveal case (scoped cleanup below).
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: otherAccount,
        password: 'Init1234!',
        email: `${otherAccount}@e2e.test`,
        name: 'Apikey E2E Other',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    otherToken = await login(app, otherAccount, 'Init1234!');
    const other = await prisma.user.findFirst({
      where: { account: otherAccount },
    });
    otherUserId = other!.id;

    // Cleanup any apikeys left from prior runs so the max-5 test starts at 0.
    const list = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const existing = (list.body as ApiEnvelope<ApiKeySnake[]>).data ?? [];
    for (const k of existing) {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/apikey/${k.id}`)
        .set(TOKEN_HEADER, token);
    }
  });

  afterAll(async () => {
    // Clean up all keys created during this run so dev.db stays pristine.
    for (const id of createdIds) {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/apikey/${id}`)
        .set(TOKEN_HEADER, token);
    }
    if (otherUserId) {
      await prisma.user.deleteMany({ where: { id: otherUserId } });
    }
    await app.close();
  });

  it('GET /system/apikey without token → 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/system/apikey');
    expect(res.status).toBe(401);
  });

  it('GET /system/apikey (initially empty after cleanup) → empty array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<ApiKeySnake[]>).data).toEqual([]);
  });

  it('POST /system/apikey creates a key (server-generated) → {id}', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<{ id: number }>).data;
    expect(typeof data.id).toBe('number');
    firstId = data.id;
    createdIds.push(firstId);
  });

  it('GET /system/apikey returns the created key as snake_case with MASKED secret_key + epoch-ms create_time (review P0-2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<ApiKeySnake[]>).data;
    expect(data).toHaveLength(1);
    const k = data[0];
    expect(k.id).toBe(firstId);
    expect(typeof k.access_key).toBe('string');
    expect(k.access_key.length).toBeGreaterThan(0);
    // secret_key is MASKED on the list — bulk plaintext is gone (P0-2);
    // the field stays present (empty) for frontend column compatibility.
    expect(k.secret_key).toBe('');
    expect(k.status).toBe(true);
    // create_time is a numeric epoch-ms timestamp (not ISO, not Date).
    expect(typeof k.create_time).toBe('number');
    expect(k.create_time).toBeGreaterThan(0);
  });

  it('GET /system/apikey/:id/secret without token → 401', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/system/apikey/${firstId}/secret`,
    );
    expect(res.status).toBe(401);
  });

  it('GET /system/apikey/:id/secret (owner) → decrypts to the 64-hex plaintext', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/apikey/${firstId}/secret`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<{ id: number; secret_key: string }>)
      .data;
    expect(data.id).toBe(firstId);
    // secrets are generated as randomBytes(32).toString('hex')
    expect(data.secret_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /system/apikey/:id/secret for ANOTHER user → 404 (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/apikey/${firstId}/secret`)
      .set(TOKEN_HEADER, otherToken);
    expect(res.status).toBe(404);
  });

  it('GET /system/apikey/:id/secret with unknown id → 404', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/apikey/999999/secret')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  it('PUT /system/apikey/status {id, status:false} toggles off; re-GET shows status false', async () => {
    const targetId = await ensureFirstId();
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/apikey/status')
      .set(TOKEN_HEADER, token)
      .send({ id: targetId, status: false });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    const get = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const k = (get.body as ApiEnvelope<ApiKeySnake[]>).data.find(
      (x) => x.id === targetId,
    );
    expect(k?.status).toBe(false);
  });

  it('PUT /system/apikey/status {id, status:true} toggles back on', async () => {
    const targetId = await ensureFirstId();
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/apikey/status')
      .set(TOKEN_HEADER, token)
      .send({ id: targetId, status: true });
    expect(res.status).toBe(200);
    const get = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const k = (get.body as ApiEnvelope<ApiKeySnake[]>).data.find(
      (x) => x.id === targetId,
    );
    expect(k?.status).toBe(true);
  });

  it('POST /system/apikey enforces the 5-key cap (6th → 400)', async () => {
    // Create 4 more (total 5 with the first key).
    for (let i = 0; i < 4; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/system/apikey')
        .set(TOKEN_HEADER, token)
        .send({});
      expect(res.status).toBe(200);
      createdIds.push((res.body as ApiEnvelope<{ id: number }>).data.id);
    }
    // 6th should be rejected.
    const over = await request(app.getHttpServer())
      .post('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(over.status).toBe(400);
  });

  it('DELETE /system/apikey/:id removes the key; re-GET shows one fewer', async () => {
    const targetId = await ensureFirstId();
    const before = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const beforeCount = (before.body as ApiEnvelope<ApiKeySnake[]>).data.length;

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/system/apikey/${targetId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );

    const after = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const afterData = (after.body as ApiEnvelope<ApiKeySnake[]>).data;
    expect(afterData.length).toBe(beforeCount - 1);
    expect(afterData.find((x) => x.id === targetId)).toBeUndefined();
    // Remove from createdIds so afterAll doesn't try to re-delete it.
    const idx = createdIds.indexOf(targetId);
    if (idx >= 0) createdIds.splice(idx, 1);
  });

  it('DELETE /system/apikey/:id with unknown id → 404 (ownership: not found)', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/apikey/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  it('PUT /system/apikey/status with unknown id → 404 (ownership: not found)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/apikey/status')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999, status: true });
    expect(res.status).toBe(404);
  });
});
