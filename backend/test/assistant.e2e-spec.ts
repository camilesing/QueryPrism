// Assistant e2e — verifies the admin surface (Phase 10d cycle 2)
// end-to-end against the real AppModule + real Prisma (admin token). Admin
// routes mount under /system/assistant (snake_case wire); the public controller
// stays at bare /assistant (Phase 8 — Phase 11 xpack cert will align it).
//
// Reverse-engineered from frontend api/embedded.ts + views/system/embedded/
// iframe.vue (§100): GET/POST/PUT/DELETE bare RESTful verbs (NOT action-style
// POST verbs like dashboard). Exercises: 401 → create (type 0) → list (snake,
// no app_secret) → create (type 1) → advanced_application ({id,name}) →
// update (id-in-body) → 400 missing id → 404 non-existent → delete → public
// info/app by appId (no token) → public 404. beforeAll/afterAll sweep all
// assistants for serial-e2e dev.db hygiene (§104).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  signEnvelope,
  type SignPayload,
} from './../src/assistant/embedded-sign.service';
import { EMBEDDED_SIGN_DEV_SECRET } from './../src/common/constants/embedded-sign-dev-secret';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';
const ASSISTANT_TOKEN_HEADER = 'X-QUERYPRISM-ASSISTANT-TOKEN';
const SIGN_HEADER = 'QUERYPRISM-EMBEDDED-SIGN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T;
}

// Snake wire shape emitted by toAssistantSnake (§100 — frontend reads these).
interface AssistantSnake {
  id: number;
  name: string;
  type: number;
  description: string | null;
  configuration: string; // JSON string (frontend JSON.parse it)
  domain: string | null;
  app_id: string;
  enable_custom_model: boolean;
  custom_model: unknown;
  status: string;
  create_time: number;
  update_time: number;
}

// Public SafeAssistant (camelCase — Phase 8 controller, unchanged).
interface PublicAssistant {
  id: number;
  appId: string;
  name: string;
  type: number;
  status: string;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function sweepAll(app: INestApplication<App>, token: string) {
  const list = await request(app.getHttpServer())
    .get('/api/v1/system/assistant')
    .set(TOKEN_HEADER, token);
  const rows = (list.body as ApiEnvelope<AssistantSnake[]>).data ?? [];
  for (const r of rows) {
    await request(app.getHttpServer())
      .delete(`/api/v1/system/assistant/${r.id}`)
      .set(TOKEN_HEADER, token);
  }
}

/** Phase 11F (§109/§68): construct a valid QUERYPRISM-EMBEDDED-SIGN envelope.
 *  Delegates to the exported `signEnvelope` (§121 gap #3) — the e2e now
 *  exercises the SAME code path integrators use (sign/verify parity is
 *  self-proving). Reads the same `EMBEDDED_SIGN_SECRET` the server uses. */
function makeEmbeddedSign(payload: SignPayload): string {
  const secret = process.env.EMBEDDED_SIGN_SECRET ?? EMBEDDED_SIGN_DEV_SECRET;
  return signEnvelope(payload, secret);
}

describe('Assistant (e2e)', () => {
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
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/assistant',
    );
    expect(res.status).toBe(401);
  });

  it('manages the admin lifecycle (snake wire, no app_secret leaked)', async () => {
    const suffix = Date.now();
    try {
      // create type 0 (basic) → 200 (§91 @HttpCode) + snake shape + app_id
      const created = await request(app.getHttpServer())
        .post('/api/v1/system/assistant')
        .set(TOKEN_HEADER, token)
        .send({
          name: `e2e-basic-${suffix}`,
          type: 0,
          description: 'a basic helper',
          domain: 'https://a.example.com,https://b.example.com',
          configuration: JSON.stringify({ oid: 1, public_list: [1, 2] }),
          enable_custom_model: false,
          custom_model: null,
        });
      expect(created.status).toBe(200);
      const cr = (created.body as ApiEnvelope<AssistantSnake>).data;
      expect(cr.name).toBe(`e2e-basic-${suffix}`);
      expect(cr.type).toBe(0);
      expect(cr.description).toBe('a basic helper');
      // configuration is a JSON STRING (frontend JSON.parse it)
      expect(typeof cr.configuration).toBe('string');
      expect(JSON.parse(cr.configuration)).toEqual({
        oid: 1,
        public_list: [1, 2],
      });
      expect(cr.domain).toBe('https://a.example.com,https://b.example.com');
      expect(cr.app_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(cr.enable_custom_model).toBe(false);
      expect(cr.custom_model).toBeNull();
      // app_secret MUST NOT appear in the wire shape (security)
      expect(cr).not.toHaveProperty('app_secret');
      expect(cr).not.toHaveProperty('appSecret');
      createdIds.push(cr.id);
      const appId = cr.app_id;

      // create type 1 (advanced) for the advanced_application picker
      const adv = await request(app.getHttpServer())
        .post('/api/v1/system/assistant')
        .set(TOKEN_HEADER, token)
        .send({ name: `e2e-adv-${suffix}`, type: 1, description: 'adv app' });
      expect(adv.status).toBe(200);
      const advRow = (adv.body as ApiEnvelope<AssistantSnake>).data;
      createdIds.push(advRow.id);

      // list (type!=4) includes both, snake shape
      const list = await request(app.getHttpServer())
        .get('/api/v1/system/assistant')
        .set(TOKEN_HEADER, token);
      expect(list.status).toBe(200);
      const listData = (list.body as ApiEnvelope<AssistantSnake[]>).data;
      expect(listData.some((a) => a.id === cr.id)).toBe(true);
      expect(listData.some((a) => a.id === advRow.id)).toBe(true);
      // no row leaks app_secret
      expect(listData.every((a) => !('app_secret' in a))).toBe(true);

      // advanced_application list → type==1 only, {id, name} shape
      const advList = await request(app.getHttpServer())
        .get('/api/v1/system/assistant/advanced_application')
        .set(TOKEN_HEADER, token);
      expect(advList.status).toBe(200);
      const advData = (
        advList.body as ApiEnvelope<{ id: number; name: string }[]>
      ).data;
      expect(advData.some((a) => a.id === advRow.id)).toBe(true);
      // each item is exactly {id, name} (picker shape)
      expect(
        advData.every((a) => Object.keys(a).sort().join() === 'id,name'),
      ).toBe(true);

      // update (id IN THE BODY, not path) — rename + reconfigure
      const renamed = await request(app.getHttpServer())
        .put('/api/v1/system/assistant')
        .set(TOKEN_HEADER, token)
        .send({
          id: cr.id,
          name: `e2e-renamed-${suffix}`,
          type: 0,
          description: 'updated desc',
          domain: 'http://c.example.com',
          configuration: JSON.stringify({ auto_ds: true }),
          enable_custom_model: true,
          custom_model: 'gpt-4o',
        });
      expect(renamed.status).toBe(200);
      const rn = (renamed.body as ApiEnvelope<AssistantSnake>).data;
      expect(rn.name).toBe(`e2e-renamed-${suffix}`);
      expect(rn.description).toBe('updated desc');
      expect(rn.domain).toBe('http://c.example.com');
      expect(JSON.parse(rn.configuration)).toEqual({ auto_ds: true });
      expect(rn.enable_custom_model).toBe(true);
      expect(rn.custom_model).toBe('gpt-4o');

      // public info by appId — NO token (embedded page lookup, Phase 8 surface)
      const info = await request(app.getHttpServer()).get(
        `/api/v1/assistant/info/${appId}`,
      );
      expect(info.status).toBe(200);
      const infoData = (info.body as ApiEnvelope<unknown>).data as {
        name: string;
        type: number;
      };
      expect(infoData.name).toBe(`e2e-renamed-${suffix}`);
      expect(infoData.type).toBe(0);

      // public app by appId — NO token (full safe assistant, camelCase Phase 8)
      const pub = await request(app.getHttpServer()).get(
        `/api/v1/assistant/app/${appId}`,
      );
      expect(pub.status).toBe(200);
      const pubData = (pub.body as ApiEnvelope<PublicAssistant>).data;
      expect(pubData.appId).toBe(appId);
      expect(pubData).not.toHaveProperty('appSecret');

      // delete → 200, then list no longer has it
      const del = await request(app.getHttpServer())
        .delete(`/api/v1/system/assistant/${cr.id}`)
        .set(TOKEN_HEADER, token);
      expect(del.status).toBe(200);
      createdIds.splice(createdIds.indexOf(cr.id), 1);
    } finally {
      for (const id of [...createdIds].reverse()) {
        await request(app.getHttpServer())
          .delete(`/api/v1/system/assistant/${id}`)
          .set(TOKEN_HEADER, token);
      }
      createdIds.length = 0;
    }
  });

  it('rejects update without id in body (400)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id', type: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for update of a non-existent assistant (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999, name: 'ghost', type: 0 });
    expect(res.status).toBe(404);
    // Phase 9 (§60): error bodies are plain strings.
    expect(typeof res.text).toBe('string');
  });

  it('public info 404s for an unknown appId', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/assistant/info/nonexistent-app-id',
    );
    expect(res.status).toBe(404);
  });

  // ---------------- Phase 11F: §109/§68 embedded sign + assistant-token ----

  it('Phase 11F: bootstrap verifies HMAC sign + issues assistant JWT', async () => {
    const suffix = Date.now();
    const UA = 'jest/bootstrap';
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-boot-${suffix}`,
        type: 0,
        domain: 'https://embed.example.com',
      });
    expect(created.status).toBe(200);
    const asst = (created.body as ApiEnvelope<AssistantSnake>).data;
    createdIds.push(asst.id);
    try {
      const sign = makeEmbeddedSign({
        assistant_id: asst.id,
        target: 'https://embed.example.com',
        sign_time: new Date().toISOString(),
        webdriver: false,
        user_agent: UA,
        timezone: 'UTC',
      });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/system/assistant/info/${asst.id}?virtual=999`)
        .set(SIGN_HEADER, sign)
        .set('User-Agent', UA)
        // 2fefef0a: the sign's target must match the real request origin.
        .set('Origin', 'https://embed.example.com');
      expect(res.status).toBe(200);
      const data = (
        res.body as ApiEnvelope<{ id: number; appId: string; token: string }>
      ).data;
      expect(data.id).toBe(asst.id);
      expect(typeof data.token).toBe('string');
      // appSecret MUST NOT be in the bootstrap response (SafeAssistant).
      expect(data).not.toHaveProperty('appSecret');
      expect(data).not.toHaveProperty('app_secret');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/assistant/${asst.id}`)
        .set(TOKEN_HEADER, token);
      const i = createdIds.indexOf(asst.id);
      if (i >= 0) createdIds.splice(i, 1);
    }
  });

  it('Phase 11F: bootstrap rejects a bad sign (401)', async () => {
    const suffix = Date.now();
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-badsign-${suffix}`,
        type: 0,
        domain: 'https://embed.example.com',
      });
    expect(created.status).toBe(200);
    const asst = (created.body as ApiEnvelope<AssistantSnake>).data;
    createdIds.push(asst.id);
    try {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/system/assistant/info/${asst.id}`)
        .set(SIGN_HEADER, 'not-a-valid-sign')
        .set('User-Agent', 'jest/badsign');
      expect(res.status).toBe(401);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/assistant/${asst.id}`)
        .set(TOKEN_HEADER, token);
      const i = createdIds.indexOf(asst.id);
      if (i >= 0) createdIds.splice(i, 1);
    }
  });

  it('2fefef0a: bootstrap rejects a sign whose target mismatches the request origin (401)', async () => {
    const suffix = Date.now();
    const UA = 'jest/originmismatch';
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-originmm-${suffix}`,
        type: 0,
        domain: 'https://embed.example.com',
      });
    expect(created.status).toBe(200);
    const asst = (created.body as ApiEnvelope<AssistantSnake>).data;
    createdIds.push(asst.id);
    try {
      // Valid HMAC + target IS domain-whitelisted, but the request actually
      // originates from a DIFFERENT origin → rejected before the whitelist.
      const sign = makeEmbeddedSign({
        assistant_id: asst.id,
        target: 'https://embed.example.com',
        sign_time: new Date().toISOString(),
        webdriver: false,
        user_agent: UA,
        timezone: 'UTC',
      });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/system/assistant/info/${asst.id}`)
        .set(SIGN_HEADER, sign)
        .set('User-Agent', UA)
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(401);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/assistant/${asst.id}`)
        .set(TOKEN_HEADER, token);
      const i = createdIds.indexOf(asst.id);
      if (i >= 0) createdIds.splice(i, 1);
    }
  });

  it('Phase 11F: /chat/assistant/start accepts a valid assistant token (200)', async () => {
    const suffix = Date.now();
    const UA = 'jest/chatstart';
    // create → bootstrap (get assistant JWT) → chat start with the token
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/assistant')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-chatstart-${suffix}`,
        type: 0,
        domain: 'https://embed.example.com',
      });
    expect(created.status).toBe(200);
    const asst = (created.body as ApiEnvelope<AssistantSnake>).data;
    createdIds.push(asst.id);
    try {
      const sign = makeEmbeddedSign({
        assistant_id: asst.id,
        target: 'https://embed.example.com',
        sign_time: new Date().toISOString(),
        webdriver: false,
        user_agent: UA,
        timezone: 'UTC',
      });
      const boot = await request(app.getHttpServer())
        .get(`/api/v1/system/assistant/info/${asst.id}?virtual=999`)
        .set(SIGN_HEADER, sign)
        .set('User-Agent', UA)
        // 2fefef0a: the sign's target must match the real request origin.
        .set('Origin', 'https://embed.example.com');
      expect(boot.status).toBe(200);
      const assistantToken = (boot.body as ApiEnvelope<{ token: string }>).data
        .token;

      // chat start with the assistant token (NOT the admin JWT) → 200
      const start = await request(app.getHttpServer())
        .post('/api/v1/chat/assistant/start')
        .set(ASSISTANT_TOKEN_HEADER, `Assistant ${assistantToken}`)
        .send({});
      expect(start.status).toBe(200);
      const chat = (start.body as ApiEnvelope<{ id: number }>).data;
      expect(typeof chat.id).toBe('number');
      // origin=2 (embedded) is hardcoded in the assistantStart handler; the
      // snake wire shape doesn't surface origin, so it's not asserted here —
      // the 200 alone proves the AssistantTokenGuard authorized the call.
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/system/assistant/${asst.id}`)
        .set(TOKEN_HEADER, token);
      const i = createdIds.indexOf(asst.id);
      if (i >= 0) createdIds.splice(i, 1);
    }
  });

  it('Phase 11F: /chat/assistant/start rejects admin JWT only (401 — guard swap)', async () => {
    // The route is @Public()'d from the class-level JwtAuthGuard + runs the
    // method-level AssistantTokenGuard. An admin JWT (X-QUERYPRISM-TOKEN) without
    // an X-QUERYPRISM-ASSISTANT-TOKEN must be rejected — proving the guard swap.
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/assistant/start')
      .set(TOKEN_HEADER, token) // admin JWT, NOT an assistant token
      .send({});
    expect(res.status).toBe(401);
  });
});
