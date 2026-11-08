// ai-model e2e — Phase 10 §43/§67/§82/§89. Covers the 8 main
// /system/aimodel routes + 4 ws_mapping routes + the 401 guard. The SSE status route is exercised via a no-apiKey model so
// LlmService.resolveModel returns null → {success:false, message:'未配置...'}
// WITHOUT a network call (fast, deterministic, no LLM endpoint needed).
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

interface AiModelSnake {
  id: number;
  supplier: number;
  name: string;
  model_type: number;
  base_model: string | null;
  default_model: boolean;
  has_api_key: boolean;
  api_domain: string | null;
  protocol: number;
  config: unknown;
  status: string;
  create_time: string;
  update_time: string;
  api_key?: string;
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

describe('AiModel + platform (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let modelId: number;
  let defaultWsOid: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    token = await login(app);

    // Derive the admin's default workspace oid (seeded 'default' workspace)
    // for ws_mapping + list_by_ws (which read currentUser.oid).
    const info = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, token);
    defaultWsOid = (info.body as ApiEnvelope<{ oid: number }>).data.oid;
  });

  afterAll(async () => {
    // Best-effort cleanup of the test model (delete cascades mappings).
    if (modelId) {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/aimodel/${modelId}`)
        .set(TOKEN_HEADER, token)
        .catch(() => {});
    }
    await app.close();
  });

  // ─── list / default / by_ws (specific literals before :id, §92) ────────

  it('GET /system/aimodel returns a snake_case list (no api_key, has has_api_key)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/aimodel')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<AiModelSnake[]>;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const m = body.data[0];
      expect(typeof m.supplier).toBe('number');
      expect(typeof m.model_type).toBe('number');
      expect(typeof m.protocol).toBe('number');
      expect(typeof m.has_api_key).toBe('boolean');
      // list mode never leaks api_key
      expect(m.api_key).toBeUndefined();
    }
  });

  it('GET /system/aimodel?keyword= filters by name substring', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/aimodel')
      .query({ keyword: '__no_such_model__' })
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<unknown[]>).data).toHaveLength(0);
  });

  it('GET /system/aimodel/list/by_ws derives oid from the JWT (no query param)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/aimodel/list/by_ws')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as ApiEnvelope<unknown[]>).data)).toBe(true);
  });

  // ─── create → get/:id (§67) → update → setDefault → ws_mapping → delete ─

  it('POST /system/aimodel creates a model (numeric supplier/protocol coerced; apiKey AES-encrypted at rest)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/aimodel')
      .set(TOKEN_HEADER, token)
      .send({
        supplier: 1,
        name: `e2e-model-${Date.now()}`,
        modelType: 0,
        baseModel: 'qwen-plus',
        apiKey: 'sk-plaintext-e2e',
        apiDomain: 'http://127.0.0.1:39999/v1',
        protocol: 1,
        config: { temperature: 0.7 },
        status: 'active',
      });
    expect(res.status).toBe(200);
    const m = (res.body as ApiEnvelope<AiModelSnake>).data;
    expect(m.supplier).toBe(1);
    expect(m.model_type).toBe(0);
    expect(m.protocol).toBe(1);
    expect(m.has_api_key).toBe(true);
    // create response is list-mode (no api_key) — frontend re-fetches via GET /:id
    expect(m.api_key).toBeUndefined();
    expect(m.config).toEqual({ temperature: 0.7 });
    modelId = m.id;
  });

  it('GET /system/aimodel/:id returns the model with api_key DECRYPTED to plaintext (§67)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const m = (res.body as ApiEnvelope<AiModelSnake>).data;
    // §67: single-GET surfaces plaintext api_key for the edit form
    expect(m.api_key).toBe('sk-plaintext-e2e');
    expect(m.has_api_key).toBe(true);
  });

  it('GET /system/aimodel/:id 404s (plain string) for an unknown id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/aimodel/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
  });

  it('PUT /system/aimodel (body-id) updates provided fields + re-encrypts apiKey', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/aimodel')
      .set(TOKEN_HEADER, token)
      .send({
        id: modelId,
        name: `e2e-model-renamed-${Date.now()}`,
        apiKey: 'sk-rotated',
      });
    expect(res.status).toBe(200);
    const m = (res.body as ApiEnvelope<AiModelSnake>).data;
    expect(m.id).toBe(modelId);
    // re-GET to confirm the rotated key is decryptable to the new plaintext
    const get = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}`)
      .set(TOKEN_HEADER, token);
    expect((get.body as ApiEnvelope<AiModelSnake>).data.api_key).toBe(
      'sk-rotated',
    );
  });

  it('PUT /system/aimodel 400s when id is missing', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/aimodel')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id' });
    expect(res.status).toBe(400);
  });

  it('PUT /system/aimodel/default/:id sets this model as default', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/system/aimodel/default/${modelId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<AiModelSnake>).data.default_model).toBe(
      true,
    );
  });

  it('GET /system/aimodel/default returns the (now-default) model', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/aimodel/default')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<AiModelSnake | null>).data;
    expect(data).not.toBeNull();
    expect(data?.id).toBe(modelId);
  });

  // ─── SSE status (no-apiKey path → resolveModel null → no network call) ─

  it('POST /system/aimodel/status streams an SSE error frame for a model with no apiKey (no network)', async () => {
    // Create a no-apiKey model so LlmService.resolveModel returns null →
    // {success:false, message:'未配置...'} without any HTTP call.
    const create = await request(app.getHttpServer())
      .post('/api/v1/system/aimodel')
      .set(TOKEN_HEADER, token)
      .send({
        supplier: 1,
        name: `e2e-nokey-${Date.now()}`,
        modelType: 0,
        protocol: 1,
      });
    const noKeyId = (create.body as ApiEnvelope<AiModelSnake>).data.id;

    const res = await request(app.getHttpServer())
      .post('/api/v1/system/aimodel/status')
      .set(TOKEN_HEADER, token)
      .send({ id: noKeyId });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // one data: frame carrying an error key (frontend reads data.error)
    expect(res.text).toContain('data:');
    expect(res.text).toContain('error');

    await request(app.getHttpServer())
      .delete(`/api/v1/system/aimodel/${noKeyId}`)
      .set(TOKEN_HEADER, token);
  });

  it('POST /system/aimodel/status 404s (plain string) for an unknown id (before stream opens)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/aimodel/status')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999 });
    expect(res.status).toBe(404);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
  });

  // ─── ws_mapping (model↔workspace binding, §100 bulk string[]) ───────────

  // Frontend sends `string[]` of oid-as-string for POST/PUT/DELETE and reads
  // GET as `string[]` (AuthorizedWorkspaceDialogForModel.vue:187 uses
  // `.includes(`${ele.id}`)` — SameValueZero, requires string elements;
  // ForModelAdd.vue:186 + Draw.vue:261/288 send `string[]`).

  it('POST /system/aimodel/:id/ws_mapping bulk-adds bindings (string[])', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token)
      .send([String(defaultWsOid)]);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
  });

  it('GET /system/aimodel/:id/ws_mapping lists as string[] of oid', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<string[]>).data;
    expect(Array.isArray(data)).toBe(true);
    // Must be string elements (frontend .includes(`${id}`) is SameValueZero).
    expect(data.some((oid) => oid === String(defaultWsOid))).toBe(true);
  });

  it('PUT /system/aimodel/:id/ws_mapping bulk-replaces with empty (wipes)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token)
      .send([]); // replace entire set with nothing → wipe
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify wipe semantics: GET now empty.
    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token);
    expect((getRes.body as ApiEnvelope<string[]>).data).toEqual([]);
  });

  it('DELETE /system/aimodel/:id/ws_mapping bulk-removes (string[])', async () => {
    // Re-add a binding first (PUT wiped it in the previous test).
    await request(app.getHttpServer())
      .post(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token)
      .send([String(defaultWsOid)]);
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token)
      .send([String(defaultWsOid)]);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify removal: GET empty.
    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}/ws_mapping`)
      .set(TOKEN_HEADER, token);
    expect((getRes.body as ApiEnvelope<string[]>).data).toEqual([]);
  });

  // ─── DELETE + 401 guard ────────────────────────────────────────────────

  it('DELETE /system/aimodel/:id removes the model (cascade drops mappings)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/system/aimodel/${modelId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // confirm it's gone
    const get = await request(app.getHttpServer())
      .get(`/api/v1/system/aimodel/${modelId}`)
      .set(TOKEN_HEADER, token);
    expect(get.status).toBe(404);
    modelId = 0; // skip afterAll cleanup
  });

  it('rejects unauthenticated GET /system/aimodel with 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/aimodel',
    );
    expect(res.status).toBe(401);
  });
});
