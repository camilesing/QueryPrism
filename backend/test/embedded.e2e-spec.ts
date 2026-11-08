// Embedded e2e — verifies the embedded-app management surface
// (Phase 10d cycle 3) end-to-end against the real AppModule + real
// Prisma. Admin routes mount under /system/embedded (snake_case wire).
//
// This suite verifies the frontend contract
// (api/embedded.ts embeddedApi + views/system/embedded/Page.vue) is satisfied:
//   - GET    /:pageNum/:pageSize?keyword= → {items, total} with PLAINTEXT
//     app_secret per row (decrypt-on-read — Page.vue shows + copies it)
//   - POST   /  → EmbeddedSnake with app_secret NULL (frontend re-fetches list)
//   - PUT    /  → EmbeddedSnake with app_secret NULL (id-in-body)
//   - DELETE /  body number[] (bare JSON array) → {success:true} (batch)
//   - PATCH  /secret/:id → {success:true} (rotate; next list shows new value)
//
// beforeAll/afterAll sweep all type==4 rows for serial-e2e dev.db hygiene
// (§104) — the assistant e2e's sweep only handles type!=4 (its list excludes
// type==4), so this suite owns its own kind.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T;
}

// Snake wire shape emitted by toEmbeddedSnake (§109). `app_secret` is null on
// create/update responses (frontend re-fetches list) and the decrypted
// plaintext on the list response.
interface EmbeddedSnake {
  id: number;
  name: string;
  app_id: string;
  app_secret: string | null;
  domain: string | null;
  type: number;
  configuration: string;
  description: string | null;
  status: string;
  create_time: number;
  update_time: number;
}

interface EmbeddedList {
  items: EmbeddedSnake[];
  total: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function sweepAll(app: INestApplication<App>, token: string) {
  const list = await request(app.getHttpServer())
    .get('/api/v1/system/embedded/1/1000')
    .set(TOKEN_HEADER, token);
  const items = (list.body as ApiEnvelope<EmbeddedList>).data?.items ?? [];
  if (items.length === 0) return;
  await request(app.getHttpServer())
    .delete('/api/v1/system/embedded')
    .set(TOKEN_HEADER, token)
    .send(items.map((i) => i.id));
}

describe('Embedded (e2e)', () => {
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
      '/api/v1/system/embedded/1/10',
    );
    expect(res.status).toBe(401);
  });

  it('manages the embedded lifecycle (snake wire, plaintext app_secret on list, null on create/update, rotate works)', async () => {
    const suffix = Date.now();
    try {
      // create type==4 (forced) → 200 (§91 @HttpCode) + snake shape,
      // app_secret NULL in response (frontend re-fetches list to see it)
      const created = await request(app.getHttpServer())
        .post('/api/v1/system/embedded')
        .set(TOKEN_HEADER, token)
        .send({
          name: `e2e-embed-${suffix}`,
          domain: 'https://embed.example.com',
          configuration: JSON.stringify({ oid: 1, theme: 'dark' }),
          description: 'an embedded app',
        });
      expect(created.status).toBe(200);
      const cr = (created.body as ApiEnvelope<EmbeddedSnake>).data;
      expect(cr.name).toBe(`e2e-embed-${suffix}`);
      expect(cr.type).toBe(4); // forced — body.type absent, type is 4
      expect(cr.domain).toBe('https://embed.example.com');
      expect(cr.description).toBe('an embedded app');
      expect(JSON.parse(cr.configuration)).toEqual({ oid: 1, theme: 'dark' });
      expect(cr.app_id).toMatch(UUID_RE);
      expect(cr.app_secret).toBeNull(); // NULL on create response
      createdIds.push(cr.id);

      // list → {items, total}; each row has PLAINTEXT app_secret (decrypted)
      const list = await request(app.getHttpServer())
        .get(`/api/v1/system/embedded/1/10?keyword=e2e-embed-${suffix}`)
        .set(TOKEN_HEADER, token);
      expect(list.status).toBe(200);
      const listData = (list.body as ApiEnvelope<EmbeddedList>).data;
      expect(listData.total).toBeGreaterThanOrEqual(1);
      const row = listData.items.find((i) => i.id === cr.id)!;
      expect(row).toBeDefined();
      expect(row.app_id).toBe(cr.app_id);
      // app_secret is the DECRYPTED plaintext (32 random bytes as 64 hex chars)
      expect(typeof row.app_secret).toBe('string');
      expect(row.app_secret).toMatch(/^[0-9a-f]{64}$/);
      const firstSecret = row.app_secret!;

      // update (id IN BODY) → 200, app_secret still null in response
      const renamed = await request(app.getHttpServer())
        .put('/api/v1/system/embedded')
        .set(TOKEN_HEADER, token)
        .send({
          id: cr.id,
          name: `e2e-embed-renamed-${suffix}`,
          domain: 'http://new.example.com',
          configuration: JSON.stringify({ oid: 1, theme: 'light' }),
        });
      expect(renamed.status).toBe(200);
      const rn = (renamed.body as ApiEnvelope<EmbeddedSnake>).data;
      expect(rn.name).toBe(`e2e-embed-renamed-${suffix}`);
      expect(rn.domain).toBe('http://new.example.com');
      expect(JSON.parse(rn.configuration)).toEqual({ oid: 1, theme: 'light' });
      expect(rn.app_secret).toBeNull(); // still null on update response

      // rotate secret → 200 + {success:true}
      const rot = await request(app.getHttpServer())
        .patch(`/api/v1/system/embedded/secret/${cr.id}`)
        .set(TOKEN_HEADER, token);
      expect(rot.status).toBe(200);
      expect((rot.body as ApiEnvelope<{ success: boolean }>).data).toEqual({
        success: true,
      });

      // list again → app_secret CHANGED (rotate worked; decrypt-on-read still)
      const list2 = await request(app.getHttpServer())
        .get(`/api/v1/system/embedded/1/10?keyword=e2e-embed-renamed-${suffix}`)
        .set(TOKEN_HEADER, token);
      const list2Data = (list2.body as ApiEnvelope<EmbeddedList>).data;
      const row2 = list2Data.items.find((i) => i.id === cr.id)!;
      expect(row2.app_secret).not.toBe(firstSecret);
      expect(row2.app_secret).toMatch(/^[0-9a-f]{64}$/);

      // delete (bare JSON array body) → 200 + {success:true}
      const del = await request(app.getHttpServer())
        .delete('/api/v1/system/embedded')
        .set(TOKEN_HEADER, token)
        .send([cr.id]);
      expect(del.status).toBe(200);
      expect((del.body as ApiEnvelope<{ success: boolean }>).data).toEqual({
        success: true,
      });
      createdIds.splice(createdIds.indexOf(cr.id), 1);

      // verify it's gone (keyword search no longer returns it)
      const list3 = await request(app.getHttpServer())
        .get(`/api/v1/system/embedded/1/10?keyword=e2e-embed-renamed-${suffix}`)
        .set(TOKEN_HEADER, token);
      const list3Data = (list3.body as ApiEnvelope<EmbeddedList>).data;
      expect(list3Data.items.find((i) => i.id === cr.id)).toBeUndefined();
    } finally {
      if (createdIds.length > 0) {
        await request(app.getHttpServer())
          .delete('/api/v1/system/embedded')
          .set(TOKEN_HEADER, token)
          .send([...createdIds]);
        createdIds.length = 0;
      }
    }
  });

  it('rejects update without id in body (400)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/embedded')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for update of a non-existent embedded app (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/embedded')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999, name: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check // §60 plain-string error
  });

  it('returns 404 for rotate-secret of a non-existent embedded app', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/system/embedded/secret/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });
});
