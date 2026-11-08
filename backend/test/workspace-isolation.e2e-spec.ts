// Workspace isolation e2e — the behaviours introduced by the workspace
// isolation pass:
//   - User.oid in the DB is authoritative per request (switching workspaces
//     takes effect with the SAME token; no re-login).
//   - Datasources (and their children) are workspace-scoped.
//   - Role model: system admin (uid 1) / workspace admin (UserWs.weight != 0)
//     / ordinary member, enforced by AdminGuard + WsAdminGuard.
//   - Archive → restore → permanent delete lifecycle.
//
// Runs against the compose PostgreSQL test DB (global setup resets + seeds).
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
  archived_at?: string | null;
}

interface DatasourceSnake {
  id: number;
  name: string;
  configuration?: string | null;
}

interface ChatSnake {
  id: number;
}

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';
const MEMBER_PWD = 'Member@1234';

async function login(
  app: INestApplication<App>,
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username, password });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function createUser(
  app: INestApplication<App>,
  token: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/user')
    .set(TOKEN_HEADER, token)
    .send(body);
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ id: number }>).data.id;
}

describe('Workspace isolation (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let memberToken: string;
  let wsAdminToken: string;
  let defaultOid: number;
  let memberUid: number;
  let wsAdminUid: number;
  let newbieUid: number;
  let wsB: number;
  let dsB: number;
  let chatB: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    adminToken = await login(app, 'admin', 'admin');
    const info = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, adminToken);
    const infoData = (info.body as ApiEnvelope<{ id: number; oid: number }>)
      .data;
    defaultOid = infoData.oid;

    // Workspace B + a member bound to B and the default workspace (so the
    // archive step can reset their current workspace to the default one).
    const wsRes = await request(app.getHttpServer())
      .post('/api/v1/system/workspace')
      .set(TOKEN_HEADER, adminToken)
      .send({ name: `e2e-iso-${Date.now()}` });
    expect(wsRes.status).toBe(200);
    wsB = (wsRes.body as ApiEnvelope<WorkspaceSnake>).data.id;

    memberUid = await createUser(app, adminToken, {
      account: 'e2e-iso-member',
      password: MEMBER_PWD,
      name: 'Iso Member',
      oid: wsB,
      oid_list: [wsB, defaultOid],
    });
    wsAdminUid = await createUser(app, adminToken, {
      account: 'e2e-iso-admin',
      password: 'WsAdmin@1234',
      name: 'Iso Ws Admin',
      oid: wsB,
    });
    newbieUid = await createUser(app, adminToken, {
      account: 'e2e-iso-newbie',
      password: 'Newbie@1234',
      name: 'Iso Newbie',
      oid: defaultOid,
    });

    // Admin enters workspace B to create its datasource, then returns.
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);
    const dsRes = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, adminToken)
      .send({
        name: 'iso-ds-b',
        description: 'workspace B datasource',
        type: 'sqlite',
        configuration: 'e2e-encrypted-config',
      });
    expect(dsRes.status).toBe(200);
    dsB = (dsRes.body as ApiEnvelope<DatasourceSnake>).data.id;
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${defaultOid}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);

    // Promote the second workspace-B user to workspace admin.
    await request(app.getHttpServer())
      .put('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, adminToken)
      .send({ uid: wsAdminUid, oid: wsB, weight: 1 })
      .expect(200);

    memberToken = await login(app, 'e2e-iso-member', MEMBER_PWD);
    wsAdminToken = await login(app, 'e2e-iso-admin', 'WsAdmin@1234');
  });

  afterAll(async () => {
    // Best-effort cleanup (the suite already hard-deletes the workspace).
    try {
      await request(app.getHttpServer())
        .put(`/api/v1/user/ws/${defaultOid}`)
        .set(TOKEN_HEADER, adminToken);
      for (const uid of [memberUid, wsAdminUid, newbieUid]) {
        if (uid) {
          await request(app.getHttpServer())
            .delete(`/api/v1/user/${uid}`)
            .set(TOKEN_HEADER, adminToken);
        }
      }
      // If a test failed before the permanent delete, remove it now.
      const archived = await request(app.getHttpServer())
        .get('/api/v1/system/workspace/archived')
        .set(TOKEN_HEADER, adminToken);
      const archivedList = (archived.body as ApiEnvelope<WorkspaceSnake[]>)
        .data;
      if (archivedList.some((w) => w.id === wsB)) {
        await request(app.getHttpServer())
          .delete(`/api/v1/system/workspace/${wsB}/permanent`)
          .set(TOKEN_HEADER, adminToken);
      } else {
        await request(app.getHttpServer())
          .delete(`/api/v1/system/workspace/${wsB}`)
          .set(TOKEN_HEADER, adminToken);
        await request(app.getHttpServer())
          .delete(`/api/v1/system/workspace/${wsB}/permanent`)
          .set(TOKEN_HEADER, adminToken);
      }
    } catch {
      // best-effort cleanup
    }
    await app.close();
  });

  // ─── datasource isolation ────────────────────────────────────────────

  it('member sees only workspace B datasources', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, memberToken);
    expect(res.status).toBe(200);
    const list = (res.body as ApiEnvelope<DatasourceSnake[]>).data;
    expect(list.some((d) => d.id === dsB)).toBe(true);
    // Seed datasource #1 belongs to the default workspace.
    expect(list.some((d) => d.id === 1)).toBe(false);
  });

  it('switches workspaces with the SAME token (DB-authoritative oid)', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${defaultOid}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);

    // No re-login: the same token now resolves the default workspace.
    const def = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, memberToken);
    const defList = (def.body as ApiEnvelope<DatasourceSnake[]>).data;
    expect(defList.some((d) => d.id === 1)).toBe(true);
    expect(defList.some((d) => d.id === dsB)).toBe(false);

    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
  });

  it('rejects cross-workspace datasource reads with 404', async () => {
    // Admin is currently in the default workspace; dsB is in workspace B.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/get/${dsB}`)
      .set(TOKEN_HEADER, adminToken);
    expect(res.status).toBe(404);
  });

  // ─── role enforcement ────────────────────────────────────────────────

  it('ordinary member cannot manage workspaces or datasources', async () => {
    const ws = await request(app.getHttpServer())
      .post('/api/v1/system/workspace')
      .set(TOKEN_HEADER, memberToken)
      .send({ name: 'forbidden-ws' });
    expect(ws.status).toBe(403);

    const ds = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, memberToken)
      .send({ name: 'forbidden-ds', type: 'sqlite', configuration: 'x' });
    expect(ds.status).toBe(403);
  });

  it('workspace admin manages only its own workspace (role enforced server-side)', async () => {
    // Same token — the guard re-reads UserWs.weight for the current oid.
    await request(app.getHttpServer())
      .put('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, adminToken)
      .send({ uid: memberUid, oid: wsB, weight: 1 })
      .expect(200);

    // Can manage datasources in workspace B...
    await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, memberToken)
      .send({ name: 'iso-ds-b-2', type: 'sqlite', configuration: 'x' })
      .expect(200);

    // ...can add an ordinary member to workspace B...
    await request(app.getHttpServer())
      .post('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, memberToken)
      .send({ uid_list: [newbieUid], oid: wsB })
      .expect(200);

    // ...but cannot manage workspaces, change roles, or touch another space.
    await request(app.getHttpServer())
      .post('/api/v1/system/workspace')
      .set(TOKEN_HEADER, memberToken)
      .send({ name: 'forbidden-ws-2' })
      .expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, memberToken)
      .send({ uid: newbieUid, oid: wsB, weight: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, memberToken)
      .send({ uid_list: [newbieUid], oid: defaultOid })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, memberToken)
      .expect(403);

    // A workspace admin cannot remove another workspace admin.
    await request(app.getHttpServer())
      .delete('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, memberToken)
      .send({ uid_list: [wsAdminUid], oid: wsB })
      .expect(403);
  });

  // ─── chat isolation ──────────────────────────────────────────────────

  it('chat sessions stay inside their workspace', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, memberToken)
      .send({ datasource: dsB });
    expect(start.status).toBe(200);
    chatB = (start.body as ApiEnvelope<ChatSnake>).data.id;

    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${defaultOid}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(404);
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/chat/${chatB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
  });

  // ─── archive lifecycle ───────────────────────────────────────────────

  it('archives a workspace: hidden, admin-only, data retained', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${wsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);

    // Hidden from the active list, visible in the archive.
    const active = await request(app.getHttpServer())
      .get('/api/v1/system/workspace')
      .set(TOKEN_HEADER, adminToken);
    expect(
      (active.body as ApiEnvelope<WorkspaceSnake[]>).data.some(
        (w) => w.id === wsB,
      ),
    ).toBe(false);
    const archived = await request(app.getHttpServer())
      .get('/api/v1/system/workspace/archived')
      .set(TOKEN_HEADER, adminToken);
    expect(
      (archived.body as ApiEnvelope<WorkspaceSnake[]>).data.some(
        (w) => w.id === wsB,
      ),
    ).toBe(true);

    // The member's current workspace was reset (they also belong to the
    // default workspace), and they cannot switch back into the archive.
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(403);
    // A user whose ONLY workspace was archived has oid reset to 0 and is
    // locked out until the workspace is restored/reassigned.
    await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, wsAdminToken)
      .expect(403);
    const memberDs = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, memberToken);
    expect(
      (memberDs.body as ApiEnvelope<DatasourceSnake[]>).data.some(
        (d) => d.id === dsB,
      ),
    ).toBe(false);

    // System admin may enter the archived workspace and still see its data.
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);
    const adminDs = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, adminToken);
    expect(
      (adminDs.body as ApiEnvelope<DatasourceSnake[]>).data.some(
        (d) => d.id === dsB,
      ),
    ).toBe(true);
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${defaultOid}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);
  });

  it('restores an archived workspace', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/system/workspace/${wsB}/restore`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);
    // Members whose oid was reset to 0 get the restored workspace back.
    const wsAdminInfo = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, wsAdminToken);
    expect(wsAdminInfo.status).toBe(200);
    expect((wsAdminInfo.body as ApiEnvelope<{ oid: number }>).data.oid).toBe(
      wsB,
    );
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set(TOKEN_HEADER, memberToken);
    expect(
      (list.body as ApiEnvelope<DatasourceSnake[]>).data.some(
        (d) => d.id === dsB,
      ),
    ).toBe(true);
  });

  it('permanently deletes an archived workspace and its data', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${defaultOid}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${wsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/system/workspace/${wsB}/permanent`)
      .set(TOKEN_HEADER, adminToken)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/system/workspace/${wsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(404);
    // Datasource + chat rows are gone; the member can no longer target it.
    await request(app.getHttpServer())
      .post(`/api/v1/datasource/get/${dsB}`)
      .set(TOKEN_HEADER, adminToken)
      .expect(404);
    await request(app.getHttpServer())
      .put(`/api/v1/user/ws/${wsB}`)
      .set(TOKEN_HEADER, memberToken)
      .expect(404);
    const chats = await request(app.getHttpServer())
      .get('/api/v1/chat/list')
      .set(TOKEN_HEADER, adminToken);
    expect(
      (chats.body as ApiEnvelope<ChatSnake[]>).data.some((c) => c.id === chatB),
    ).toBe(false);
  });
});
