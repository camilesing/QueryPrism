// Permission (ds_permission) e2e — verifies the datasource permission
// management surface (Phase 10d cycle 5) end-to-end against
// the real AppModule + real Prisma. Admin routes mount under /ds_permission
// (snake_case wire).
//
// This suite verifies the frontend contract (api/permissions.ts
// + views/system/permission/index.vue) is satisfied:
//   - POST /ds_permission/list        → bare array of rule groups
//   - POST /ds_permission/save        (body; id? → create|update; frontend re-fetches list)
//   - POST /ds_permission/delete/:id   (path param; frontend re-fetches list)
//
// beforeAll/afterAll sweep all DsRules rows for serial-e2e dev.db hygiene (§104)
// — no other suite touches DsRules/DsPermission (no overlap concern), but the
// sweep keeps the table clean across runs.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T;
}

// Snake wire shape emitted by toPermissionGroupSnake/toPermissionItemSnake (§111).
interface PermissionItemSnake {
  id: number;
  name: string | null;
  type: string;
  ds_id: number | null;
  ds_name: string | null;
  table_id: number | null;
  table_name: string | null;
  tree: unknown;
  permission_list: unknown[];
}

interface PermissionGroupSnake {
  id: number;
  name: string;
  permissions: PermissionItemSnake[];
  users: number[];
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
    .post('/api/v1/ds_permission/list')
    .set(TOKEN_HEADER, token);
  const items = (list.body as ApiEnvelope<PermissionGroupSnake[]>).data ?? [];
  for (const it of items) {
    await request(app.getHttpServer())
      .post(`/api/v1/ds_permission/delete/${it.id}`)
      .set(TOKEN_HEADER, token);
  }
}

describe('Permission (e2e)', () => {
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
    const res = await request(app.getHttpServer()).post(
      '/api/v1/ds_permission/list',
    );
    expect(res.status).toBe(401);
  });

  it('manages the lifecycle (snake wire, list bare array, save create/update, delete path param)', async () => {
    const suffix = Date.now();
    // Workspace isolation validates that permission items reference a real
    // datasource/table owned by the current workspace. Use the seeded
    // datasource + a temporary table instead of arbitrary ids.
    const prisma = app.get(PrismaService);
    const ds = await prisma.datasource.findFirst({ where: { oid: 1 } });
    expect(ds).not.toBeNull();
    const table = await prisma.table.create({
      data: {
        datasourceId: ds!.id,
        tableName: `e2e_perm_tbl_${suffix}`,
      },
    });
    const dsId = ds!.id;
    const tableId = table.id;
    try {
      // save CREATE (no id) → 200 (§91 @HttpCode) + {id, name}; frontend ignores
      // the response body (re-fetches list)
      const created = await request(app.getHttpServer())
        .post('/api/v1/ds_permission/save')
        .set(TOKEN_HEADER, token)
        .send({
          name: `e2e-perm-${suffix}`,
          permissions: [
            {
              name: 'row-rule',
              type: 'row',
              ds_id: dsId,
              ds_name: 'orders_ds',
              table_id: tableId,
              table_name: 'orders',
              expression_tree: '{"logic":"and","items":[]}',
              permissions: '[]',
              permission_list: [],
            },
            {
              name: 'col-rule',
              type: 'column',
              ds_id: dsId,
              ds_name: 'orders_ds',
              table_id: tableId,
              table_name: 'orders',
              expression_tree: '{}',
              permissions:
                '[{"field_id":1,"field_name":"id","field_comment":"ID","enable":true}]',
              permission_list: [],
            },
          ],
          users: [1, 2],
        });
      expect(created.status).toBe(200);
      const cr = (created.body as ApiEnvelope<{ id: number; name: string }>)
        .data;
      expect(cr.name).toBe(`e2e-perm-${suffix}`);
      expect(typeof cr.id).toBe('number');
      createdIds.push(cr.id);

      // list → bare array; find our group; assert snake shape + parsed tree +
      // permission_list (frontend reads `tree` for row, `permission_list` for
      // column — backend emits both regardless of type)
      const list = await request(app.getHttpServer())
        .post('/api/v1/ds_permission/list')
        .set(TOKEN_HEADER, token);
      expect(list.status).toBe(200);
      const groups = (list.body as ApiEnvelope<PermissionGroupSnake[]>).data;
      expect(Array.isArray(groups)).toBe(true); // bare array, NOT {items,total}
      const group = groups.find((g) => g.id === cr.id)!;
      expect(group).toBeDefined();
      expect(group.name).toBe(`e2e-perm-${suffix}`);
      expect(group.users).toEqual([1, 2]);
      expect(group.permissions).toHaveLength(2);

      const rowItem = group.permissions.find((p) => p.type === 'row')!;
      expect(rowItem.name).toBe('row-rule');
      expect(rowItem.ds_id).toBe(dsId);
      expect(rowItem.ds_name).toBe('orders_ds');
      expect(rowItem.table_id).toBe(tableId);
      expect(rowItem.table_name).toBe('orders');
      expect(rowItem.tree).toEqual({ logic: 'and', items: [] }); // parsed
      expect(rowItem.permission_list).toEqual([]); // parsed from '[]'

      const colItem = group.permissions.find((p) => p.type === 'column')!;
      expect(colItem.tree).toEqual({}); // parsed from '{}'
      expect(colItem.permission_list).toEqual([
        {
          field_id: 1,
          field_name: 'id',
          field_comment: 'ID',
          enable: true,
        },
      ]); // parsed from the JSON string

      // save UPDATE (id in body) — delete-all-recreate: rename + replace items.
      // expression_tree is a VALID tree (2026-09 P0-1: save-time validation
      // now rejects degenerate shapes like items:[1] that the evaluator
      // cannot render — they used to be stored and silently dropped at
      // query time, i.e. fail-open).
      const updateTree = {
        logic: 'or',
        items: [{ type: 'item', field_id: 41, term: 'gt', value: '18' }],
      };
      const updated = await request(app.getHttpServer())
        .post('/api/v1/ds_permission/save')
        .set(TOKEN_HEADER, token)
        .send({
          id: cr.id,
          name: `e2e-perm-renamed-${suffix}`,
          permissions: [
            {
              name: 'row-rule-2',
              type: 'row',
              ds_id: dsId,
              ds_name: 'users_ds',
              table_id: tableId,
              table_name: 'users',
              expression_tree: JSON.stringify(updateTree),
              permissions: '[]',
              permission_list: [],
            },
          ],
          users: [3, 4],
        });
      expect(updated.status).toBe(200);
      expect(
        (updated.body as ApiEnvelope<{ id: number; name: string }>).data,
      ).toEqual({ id: cr.id, name: `e2e-perm-renamed-${suffix}` });

      // list → verify update persisted (rename + 1 item + users changed)
      const list2 = await request(app.getHttpServer())
        .post('/api/v1/ds_permission/list')
        .set(TOKEN_HEADER, token);
      const groups2 = (list2.body as ApiEnvelope<PermissionGroupSnake[]>).data;
      const group2 = groups2.find((g) => g.id === cr.id)!;
      expect(group2.name).toBe(`e2e-perm-renamed-${suffix}`);
      expect(group2.users).toEqual([3, 4]);
      expect(group2.permissions).toHaveLength(1); // old 2 deleted, 1 recreated
      expect(group2.permissions[0].name).toBe('row-rule-2');
      expect(group2.permissions[0].ds_id).toBe(dsId);
      expect(group2.permissions[0].tree).toEqual(updateTree); // parsed

      // delete (path param) → 200 + [{id}]; frontend ignores body
      const del = await request(app.getHttpServer())
        .post(`/api/v1/ds_permission/delete/${cr.id}`)
        .set(TOKEN_HEADER, token);
      expect(del.status).toBe(200);
      expect((del.body as ApiEnvelope<{ id: number }[]>).data).toEqual([
        { id: cr.id },
      ]);
      createdIds.splice(createdIds.indexOf(cr.id), 1);

      // verify gone
      const list3 = await request(app.getHttpServer())
        .post('/api/v1/ds_permission/list')
        .set(TOKEN_HEADER, token);
      const groups3 = (list3.body as ApiEnvelope<PermissionGroupSnake[]>).data;
      expect(groups3.find((g) => g.id === cr.id)).toBeUndefined();
    } finally {
      if (createdIds.length > 0) {
        for (const id of [...createdIds]) {
          await request(app.getHttpServer())
            .post(`/api/v1/ds_permission/delete/${id}`)
            .set(TOKEN_HEADER, token);
        }
        createdIds.length = 0;
      }
      await prisma.table.deleteMany({ where: { id: tableId } });
    }
  });

  it('rejects save with empty name (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ds_permission/save')
      .set(TOKEN_HEADER, token)
      .send({ name: '', permissions: [], users: [] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for save update of a non-existent id (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ds_permission/save')
      .set(TOKEN_HEADER, token)
      .send({ id: 999999, name: 'ghost', permissions: [], users: [] });
    expect(res.status).toBe(404);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check // §60 plain-string error
  });

  it('returns 404 for delete of a non-existent id (ownership)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ds_permission/delete/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
  });
});
