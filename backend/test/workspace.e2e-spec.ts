// workspace e2e — Phase 10 §45/§82/§101 cycle 3. Covers the 11
// /system/workspace routes (5 workspace CRUD + 6 uws) + 401 guard + 404/400
// error cases. The uws routes are polymorphic by `oid` presence (§101 contract
// map): with oid → workspace-scoped; without oid → system-wide (default ws=1
// for create, remove-all-bindings for delete).
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

interface WorkspaceSnake {
  id: number;
  name: string;
  description: string | null;
  create_time: string;
  member_count?: number;
}

interface UwsItemSnake {
  id: number; // user id (frontend uses row.id as uid in uwsDelete)
  name: string;
  account: string;
  status: number;
  email: string | null;
  weight: number;
  create_time: string;
}

interface UserSnake {
  id: number;
  name: string;
  account: string;
  status: number;
  email: string | null;
  create_time: string;
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

describe('Workspace (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let adminUid: number;
  let defaultWsOid: number;
  let createdWsId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    token = await login(app);

    // Derive the admin's uid + default workspace oid from /user/info.
    const info = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, token);
    const infoData = (
      info.body as ApiEnvelope<{
        id: number;
        oid: number;
      }>
    ).data;
    adminUid = infoData.id;
    defaultWsOid = infoData.oid;
  });

  afterAll(async () => {
    // Restore the seed state: admin bound to default workspace, weight=0.
    // The destructive uwsDelete-without-oid test strips all bindings; re-add
    // so subsequent e2e files (which assume admin is a member of ws 1) still
    // pass. (dev.db is reverted before commit, but this keeps the run clean.)
    await request(app.getHttpServer())
      .post('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid_list: [adminUid], oid: defaultWsOid, weight: 0 });
    await app.close();
  });

  // ─── 401 guard (JwtAuthGuard, §90) ─────────────────────────────────────

  it('rejects unauthenticated workspace access with 401', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/system/workspace',
    );
    expect(res.status).toBe(401);
  });

  // ─── workspace CRUD (routes 1-5) ───────────────────────────────────────

  it('GET /system/workspace returns a snake_case array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<WorkspaceSnake[]>).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((w) => w.id === defaultWsOid)).toBe(true);
    const ws = data.find((w) => w.id === defaultWsOid)!;
    expect(ws).toHaveProperty('name');
    expect(ws).toHaveProperty('description');
    expect(ws).toHaveProperty('create_time');
    // member_count is optional (harmless extra); verify it's a number when present.
    if (ws.member_count !== undefined) {
      expect(typeof ws.member_count).toBe('number');
    }
  });

  it('GET /system/workspace/:id returns a single snake_case workspace', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const ws = (res.body as ApiEnvelope<WorkspaceSnake>).data;
    expect(ws.id).toBe(defaultWsOid);
    expect(ws).toHaveProperty('name');
    expect(ws).toHaveProperty('create_time');
  });

  it('GET /system/workspace/:id 404s for an unknown id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });

  it('POST /system/workspace creates (body carries id="" — ignored) + re-GET', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token)
      .send({ name: 'e2e-test-ws', id: '' }); // frontend sends id='' on create
    expect(res.status).toBe(200);
    const ws = (res.body as ApiEnvelope<WorkspaceSnake>).data;
    expect(ws.name).toBe('e2e-test-ws');
    expect(ws).toHaveProperty('create_time');
    createdWsId = ws.id;
    // Verify it appears in the list.
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token);
    const list = (listRes.body as ApiEnvelope<WorkspaceSnake[]>).data;
    expect(list.some((w) => w.id === createdWsId)).toBe(true);
  });

  it('PUT /system/workspace updates by body-id + re-GET confirms', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token)
      .send({ name: 'e2e-test-ws-renamed', id: createdWsId });
    expect(res.status).toBe(200);
    const ws = (res.body as ApiEnvelope<WorkspaceSnake>).data;
    expect(ws.id).toBe(createdWsId);
    expect(ws.name).toBe('e2e-test-ws-renamed');
  });

  it('PUT /system/workspace 400s when id is missing', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id' });
    expect(res.status).toBe(400);
  });

  it('DELETE /system/workspace/:id archives the workspace (soft delete)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${createdWsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Archived workspaces disappear from the active list...
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token);
    const list = (listRes.body as ApiEnvelope<WorkspaceSnake[]>).data;
    expect(list.some((w) => w.id === createdWsId)).toBe(false);
    // ...but remain visible in the admin-only archive.
    const archiveRes = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/archived')
      .set(TOKEN_HEADER, token);
    const archived = (archiveRes.body as ApiEnvelope<WorkspaceSnake[]>).data;
    const row = archived.find((w) => w.id === createdWsId)!;
    expect(row).toBeDefined();
    expect(row.archived_at).not.toBeNull();
  });

  it('PUT /system/workspace/:id/restore brings an archived workspace back', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/system/workspace/${createdWsId}/restore`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const listRes = await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, token);
    const list = (listRes.body as ApiEnvelope<WorkspaceSnake[]>).data;
    expect(list.some((w) => w.id === createdWsId)).toBe(true);
  });

  it('DELETE /system/workspace/:id/permanent hard-deletes only AFTER archiving', async () => {
    // Not archived yet → 400 (two-step safety).
    const early = await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${createdWsId}/permanent`)
      .set(TOKEN_HEADER, token);
    expect(early.status).toBe(400);

    await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${createdWsId}`)
      .set(TOKEN_HEADER, token)
      .expect(200);
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${createdWsId}/permanent`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    // Gone from both lists and by-id lookup.
    const archiveRes = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/archived')
      .set(TOKEN_HEADER, token);
    const archived = (archiveRes.body as ApiEnvelope<WorkspaceSnake[]>).data;
    expect(archived.some((w) => w.id === createdWsId)).toBe(false);
    await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/${createdWsId}`)
      .set(TOKEN_HEADER, token)
      .expect(404);
    createdWsId = 0;
  });

  it('DELETE /system/workspace/1 rejects the default workspace', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/workspace/1')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(400);
  });

  // ─── uws pager (route 6 — polymorphic by oid) ──────────────────────────

  it('GET /system/workspace/uws/pager/:n/:s?oid=1 returns {items,total} of users in workspace 1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: UwsItemSnake[];
        total: number;
      }>
    ).data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    // Admin is bound to default ws (seed); should appear.
    expect(data.items.some((u) => u.id === adminUid)).toBe(true);
    const admin = data.items.find((u) => u.id === adminUid)!;
    expect(admin).toHaveProperty('name');
    expect(admin).toHaveProperty('account');
    expect(admin).toHaveProperty('status');
    expect(admin).toHaveProperty('email');
    expect(admin).toHaveProperty('weight');
    expect(admin).toHaveProperty('create_time');
  });

  it('GET /system/workspace/uws/pager?oid&keyword=email filters members by email', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}&keyword=admin%40queryprism.local`,
      )
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: UwsItemSnake[];
        total: number;
      }>
    ).data;
    // The member-search placeholder advertises email search — it must match.
    expect(data.items.some((u) => u.id === adminUid)).toBe(true);
  });

  it('GET /system/workspace/uws/pager/:n/:s (no oid) returns all users with ≥1 binding', async () => {
    // pageSize=1000 mirrors SelectPermission.vue:161's real usage; the dev.db
    // may carry imported test users from user.e2e, so a small page would push
    // admin (oldest) off page 1. The contract assertion is "admin (who has
    // ≥1 binding per seed) appears somewhere in the full list."
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/uws/pager/1/1000')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: UwsItemSnake[];
        total: number;
      }>
    ).data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(data.total).toBeGreaterThan(0);
    // Admin has ≥1 binding (seed); should appear in the full list.
    expect(data.items.some((u) => u.id === adminUid)).toBe(true);
  });

  // ─── uws option (routes 7 + 8 — add-member candidate lookups) ──────────

  it('GET /system/workspace/uws/option/pager/:n/:s?oid=1 returns users NOT in workspace 1', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/system/workspace/uws/option/pager/1/1000?oid=${defaultWsOid}`,
      )
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (
      res.body as ApiEnvelope<{
        items: UserSnake[];
        total: number;
      }>
    ).data;
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    // Admin IS bound to ws 1 → must NOT appear in the add-candidate list.
    expect(data.items.some((u) => u.id === adminUid)).toBe(false);
  });

  it('GET /system/workspace/uws/option?keyword=admin resolves the admin user', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/uws/option?keyword=admin')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<UserSnake | null>).data;
    // Admin should be found by account substring 'admin'.
    expect(data).not.toBeNull();
    expect(data!.account).toBe('admin');
    expect(data!).toHaveProperty('name');
    expect(data!).toHaveProperty('create_time');
  });

  it('GET /system/workspace/uws/option?keyword=<email> resolves the admin user', async () => {
    const res = await request(app.getHttpServer())
      .get(
        '/api/v1/system/workspace/uws/option?keyword=admin%40queryprism.local',
      )
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<UserSnake | null>).data;
    // The add-member dialog must resolve users by email too.
    expect(data).not.toBeNull();
    expect(data!.account).toBe('admin');
  });

  it('GET /system/workspace/uws/option?keyword=nonexistent returns null', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/uws/option?keyword=zzz-no-such-user-zzz')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<UserSnake | null>).data).toBeNull();
  });

  // ─── uws mutations (routes 9-11 — polymorphic by oid) ──────────────────

  it('POST /system/workspace/uws with oid bulk-adds (idempotent re-bind)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid_list: [adminUid], oid: defaultWsOid, weight: 1 });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify weight updated to 1.
    const pager = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    const admin = (
      pager.body as ApiEnvelope<{ items: UwsItemSnake[] }>
    ).data.items.find((u) => u.id === adminUid);
    expect(admin?.weight).toBe(1);
  });

  it('PUT /system/workspace/uws updates a single user weight (uid, not uid_list)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid: adminUid, oid: defaultWsOid, weight: 0 });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify weight back to 0.
    const pager = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    const admin = (
      pager.body as ApiEnvelope<{ items: UwsItemSnake[] }>
    ).data.items.find((u) => u.id === adminUid);
    expect(admin?.weight).toBe(0);
  });

  it('DELETE /system/workspace/uws with oid removes the binding', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid_list: [adminUid], oid: defaultWsOid });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify admin no longer in workspace 1's user list.
    const pager = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    const items = (pager.body as ApiEnvelope<{ items: UwsItemSnake[] }>).data
      .items;
    expect(items.some((u) => u.id === adminUid)).toBe(false);
  });

  it('POST /system/workspace/uws without oid registers into default ws (oid=1, weight=0)', async () => {
    // Admin was just removed from ws 1 (previous test). Re-add without oid.
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid_list: [adminUid] }); // no oid, no weight
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify admin is back in ws 1 (default) with weight 0.
    const pager = await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/uws/pager/1/1000?oid=${defaultWsOid}`)
      .set(TOKEN_HEADER, token);
    const admin = (
      pager.body as ApiEnvelope<{ items: UwsItemSnake[] }>
    ).data.items.find((u) => u.id === adminUid);
    expect(admin).toBeDefined();
    expect(admin?.weight).toBe(0);
  });

  it('DELETE /system/workspace/uws without oid removes ALL bindings (system-wide)', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, token)
      .send({ uid_list: [adminUid] }); // no oid → system-wide removal
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ success: true }>).data.success).toBe(
      true,
    );
    // Verify admin no longer in the system-wide list (no bindings).
    const pager = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/uws/pager/1/10')
      .set(TOKEN_HEADER, token);
    const items = (pager.body as ApiEnvelope<{ items: UwsItemSnake[] }>).data
      .items;
    expect(items.some((u) => u.id === adminUid)).toBe(false);
    // afterAll re-binds admin to restore the seed state.
  });
});
