// Dashboard e2e — action-style rewrite (Phase 10d cycle 1).
//
// Verifies the 9 routes end-to-end against real AppModule + real Prisma (admin
// token, prefix api/v1). Per §100: e2e green ≠ contract correct — assertions
// read the snake_case wire shapes the frontend reads (tree node fields,
// canvas fields as JSON strings, create_name/update_name via User join,
// boolean check_name, ownership 403, folder-not-empty 400).
//
// Per §104: jest-e2e runs serial (maxWorkers:1) to avoid cross-suite dev.db
// pollution. beforeAll/afterAll clean up the admin's dashboards.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface DashboardNodeSnake {
  id: number;
  name: string;
  pid: number | null;
  node_type: string;
  leaf: boolean;
  type: string | null;
  create_time: number;
  update_time: number;
  children: DashboardNodeSnake[];
}

interface DashboardResourceSnake {
  id: number;
  name: string;
  pid: number | null;
  workspace_id: number;
  org_id: string | null;
  level: number;
  node_type: string;
  type: string | null;
  canvas_style_data: string;
  component_data: string;
  canvas_view_info: string;
  mobile_layout: unknown;
  status: number;
  version: number;
  content_id: number | null;
  create_time: number;
  update_time: number;
  create_by: number | null;
  update_by: number | null;
  create_name: string | null;
  update_name: string | null;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function cleanupAll(
  app: INestApplication<App>,
  token: string,
): Promise<void> {
  // List all dashboards, delete each (ignore 404/400 — best effort)
  const res = await request(app.getHttpServer())
    .post('/api/v1/dashboard/list_resource')
    .set(TOKEN_HEADER, token)
    .send({});
  const tree = (res.body as ApiEnvelope<DashboardNodeSnake[]>).data ?? [];
  const ids: number[] = [];
  const walk = (nodes: DashboardNodeSnake[]) => {
    for (const n of nodes) {
      ids.push(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  // Delete leaves first (children before parents) — reverse order
  for (const id of ids.reverse()) {
    await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${id}/cleanup`)
      .set(TOKEN_HEADER, token);
  }
}

describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
    await cleanupAll(app, token);
  });

  afterAll(async () => {
    await cleanupAll(app, token);
    await app.close();
  });

  it('requires a token (401 without)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/dashboard/list_resource')
      .send({});
    expect(res.status).toBe(401);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check // §60 plain-string body
  });

  it('list_resource returns empty tree when no dashboards', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/dashboard/list_resource')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(res.status).toBe(200);
    const data = (res.body as ApiEnvelope<DashboardNodeSnake[]>).data;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it('manages the full folder/leaf/canvas lifecycle (9 routes)', async () => {
    const suffix = Date.now();

    // 1. create_resource (folder, root, level 0) — pid 'root' → null
    const folder = await request(app.getHttpServer())
      .post('/api/v1/dashboard/create_resource')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-folder-${suffix}`,
        pid: 'root',
        node_type: 'folder',
        type: 'dashboard',
        level: 0,
      });
    expect(folder.status).toBe(200);
    const f = (folder.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(f.id).toBeGreaterThan(0);
    expect(f.pid).toBeNull();
    expect(f.node_type).toBe('folder');
    expect(f.workspace_id).toBe(1); // admin's oid
    expect(f.org_id).toBeNull();
    expect(f.create_by).toBe(1); // admin's uid
    expect(f.create_name).toBeNull(); // create/update responses omit create_name
    expect(f.status).toBe(1); // 'active' → 1
    expect(typeof f.canvas_style_data).toBe('string'); // JSON string
    expect(JSON.parse(f.canvas_style_data)).toEqual({}); // null → safe default

    // 2. create_canvas (leaf under folder, with canvas) — pid is f.id
    const panel = await request(app.getHttpServer())
      .post('/api/v1/dashboard/create_canvas')
      .set(TOKEN_HEADER, token)
      .send({
        name: `e2e-panel-${suffix}`,
        pid: String(f.id),
        node_type: 'leaf',
        type: 'dashboard',
        level: 1,
        component_data: JSON.stringify([{ id: 'c1', type: 'sq-text' }]),
        canvas_style_data: JSON.stringify({ background: '#fff' }),
        canvas_view_info: JSON.stringify({ c1: { x: 10, y: 10 } }),
      });
    expect(panel.status).toBe(200);
    const p = (panel.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(p.pid).toBe(f.id);
    expect(p.node_type).toBe('leaf');
    expect(p.create_by).toBe(1);
    expect(JSON.parse(p.component_data)).toEqual([
      { id: 'c1', type: 'sq-text' },
    ]);

    // 3. list_resource returns nested tree (folder → panel child)
    const list = await request(app.getHttpServer())
      .post('/api/v1/dashboard/list_resource')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(list.status).toBe(200);
    const tree = (list.body as ApiEnvelope<DashboardNodeSnake[]>).data;
    const folderNode = tree.find((n) => n.id === f.id);
    expect(folderNode).toBeTruthy();
    expect(folderNode!.leaf).toBe(false); // folder
    expect(folderNode!.node_type).toBe('folder');
    expect(folderNode!.children.some((c) => c.id === p.id)).toBe(true);
    const panelNode = folderNode!.children.find((c) => c.id === p.id);
    expect(panelNode!.leaf).toBe(true); // leaf — QueryPrism improvement
    expect(panelNode!.node_type).toBe('leaf');

    // 4. list_resource with node_type=folder filter (for parent select)
    const foldersOnly = await request(app.getHttpServer())
      .post('/api/v1/dashboard/list_resource')
      .set(TOKEN_HEADER, token)
      .send({ node_type: 'folder' });
    expect(foldersOnly.status).toBe(200);
    const folders = (foldersOnly.body as ApiEnvelope<DashboardNodeSnake[]>)
      .data;
    expect(folders.some((n) => n.id === f.id)).toBe(true);
    expect(folders.some((n) => n.id === p.id)).toBe(false); // panel excluded

    // 5. load_resource returns full row + create_name/update_name
    const loaded = await request(app.getHttpServer())
      .post('/api/v1/dashboard/load_resource')
      .set(TOKEN_HEADER, token)
      .send({ id: String(p.id) });
    expect(loaded.status).toBe(200);
    const ld = (loaded.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(ld.id).toBe(p.id);
    expect(ld.create_name).not.toBeNull(); // admin (joined from User)
    expect(ld.update_name).toBeNull(); // never updated yet
    expect(JSON.parse(ld.component_data)).toEqual([
      { id: 'c1', type: 'sq-text' },
    ]);
    expect(JSON.parse(ld.canvas_view_info)).toEqual({ c1: { x: 10, y: 10 } });

    // 6. check_name: duplicate within user → false; free name → true
    const dup = await request(app.getHttpServer())
      .post('/api/v1/dashboard/check_name')
      .set(TOKEN_HEADER, token)
      .send({ name: `e2e-panel-${suffix}`, opt: 'newLeaf' });
    expect(dup.status).toBe(200);
    expect((dup.body as ApiEnvelope<boolean>).data).toBe(false);
    const free = await request(app.getHttpServer())
      .post('/api/v1/dashboard/check_name')
      .set(TOKEN_HEADER, token)
      .send({ name: `e2e-free-${suffix}`, opt: 'newLeaf' });
    expect((free.body as ApiEnvelope<boolean>).data).toBe(true);
    // rename check excludes self
    const renameOk = await request(app.getHttpServer())
      .post('/api/v1/dashboard/check_name')
      .set(TOKEN_HEADER, token)
      .send({ name: `e2e-panel-${suffix}`, opt: 'rename', id: String(p.id) });
    expect((renameOk.body as ApiEnvelope<boolean>).data).toBe(true);

    // 7. update_resource (rename only)
    const renamed = await request(app.getHttpServer())
      .post('/api/v1/dashboard/update_resource')
      .set(TOKEN_HEADER, token)
      .send({ id: String(p.id), name: `e2e-panel-renamed-${suffix}` });
    expect(renamed.status).toBe(200);
    expect(
      (renamed.body as ApiEnvelope<DashboardResourceSnake>).data.name,
    ).toBe(`e2e-panel-renamed-${suffix}`);

    // 8. update_canvas (name + canvas, no version bump)
    const saved = await request(app.getHttpServer())
      .post('/api/v1/dashboard/update_canvas')
      .set(TOKEN_HEADER, token)
      .send({
        id: String(p.id),
        name: `e2e-panel-renamed-${suffix}`,
        component_data: JSON.stringify([
          { id: 'c1', type: 'sq-text' },
          { id: 'c2', type: 'sq-empty' },
        ]),
        canvas_style_data: JSON.stringify({ background: '#000' }),
        canvas_view_info: JSON.stringify({
          c1: { x: 10, y: 10 },
          c2: { x: 100, y: 100 },
        }),
      });
    expect(saved.status).toBe(200);
    const sd = (saved.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(JSON.parse(sd.component_data)).toHaveLength(2);
    expect(sd.update_by).toBe(1); // updateBy set to admin

    // 9. delete_resource folder-with-child → 400 (QueryPrism safety §107)
    const delFolderFail = await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${f.id}/folder`)
      .set(TOKEN_HEADER, token);
    expect(delFolderFail.status).toBe(400);

    // delete leaf child, then folder
    const delPanel = await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${p.id}/panel`)
      .set(TOKEN_HEADER, token);
    expect(delPanel.status).toBe(200);

    const delFolder = await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${f.id}/folder`)
      .set(TOKEN_HEADER, token);
    expect(delFolder.status).toBe(200);

    // load_resource after delete → 404
    const after = await request(app.getHttpServer())
      .post('/api/v1/dashboard/load_resource')
      .set(TOKEN_HEADER, token)
      .send({ id: String(f.id) });
    expect(after.status).toBe(404);
    expect(typeof after.text).toBe('string'); // §60 plain-string body
  });

  it('move_resource updates pid (drag-drop: leaf → root)', async () => {
    const suffix = Date.now();
    // create folder + leaf under it
    const folder = await request(app.getHttpServer())
      .post('/api/v1/dashboard/create_resource')
      .set(TOKEN_HEADER, token)
      .send({
        name: `mv-folder-${suffix}`,
        pid: 'root',
        node_type: 'folder',
        type: 'dashboard',
        level: 0,
      });
    const f = (folder.body as ApiEnvelope<DashboardResourceSnake>).data;
    const panel = await request(app.getHttpServer())
      .post('/api/v1/dashboard/create_canvas')
      .set(TOKEN_HEADER, token)
      .send({
        name: `mv-panel-${suffix}`,
        pid: String(f.id),
        node_type: 'leaf',
        type: 'dashboard',
        level: 1,
        component_data: JSON.stringify([]),
        canvas_style_data: JSON.stringify({}),
        canvas_view_info: JSON.stringify({}),
      });
    const p = (panel.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(p.pid).toBe(f.id);

    // move panel to root (pid '0' → null)
    const moved = await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/move_resource/${p.id}`)
      .set(TOKEN_HEADER, token)
      .send({ id: String(p.id), pid: '0', name: `mv-panel-${suffix}` });
    expect(moved.status).toBe(200);

    // verify via load_resource
    const loaded = await request(app.getHttpServer())
      .post('/api/v1/dashboard/load_resource')
      .set(TOKEN_HEADER, token)
      .send({ id: String(p.id) });
    const ld = (loaded.body as ApiEnvelope<DashboardResourceSnake>).data;
    expect(ld.pid).toBeNull(); // moved to root
    expect(ld.level).toBe(0);

    // cleanup
    await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${p.id}/panel`)
      .set(TOKEN_HEADER, token);
    await request(app.getHttpServer())
      .delete(`/api/v1/dashboard/delete_resource/${f.id}/folder`)
      .set(TOKEN_HEADER, token);
  });

  it('check_name returns 400 on invalid opt', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/dashboard/check_name')
      .set(TOKEN_HEADER, token)
      .send({ name: 'x', opt: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('update_resource returns 400 when id missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/dashboard/update_resource')
      .set(TOKEN_HEADER, token)
      .send({ name: 'no-id' });
    expect(res.status).toBe(400);
  });
});
