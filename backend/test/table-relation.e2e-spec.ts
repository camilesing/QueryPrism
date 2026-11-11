// Relation-graph versioning e2e (MetaDataImprove M3): every save appends an
// immutable snapshot; the current relation stays the latest save.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { waitFor } from './helpers/wait-for';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

async function login(
  app: INestApplication<App>,
  username = 'admin',
  password = 'admin',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username, password });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Table relation versions (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let dsId: number;
  let memberToken = '';
  let memberAccount = '';
  let foreignDsId = 0;
  let foreignWsId = 0;
  const stamp = Date.now();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);

    const ds = await prisma.datasource.create({
      data: { oid: 1, name: `e2e-relation-ds-${stamp}`, type: 'sqlite' },
    });
    dsId = ds.id;
    await prisma.datasourceRelationVersion.deleteMany({
      where: { datasourceId: dsId },
    });
    await prisma.datasource.update({
      where: { id: dsId },
      data: { tableRelation: [], relationVersion: 0 },
    });

    // A plain member for the 403 assertions.
    memberAccount = `e2e-relation-member-${stamp}`;
    const member = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Relation Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    expect(member.status).toBe(200);
    memberToken = await login(app, memberAccount, 'Init1234!');

    // A datasource in another workspace: the oid guard must hide it even
    // from the system admin (uid 1's current workspace is 1).
    const foreignWs = await prisma.workspace.create({
      data: { name: `e2e-relation-ws-${stamp}` },
    });
    foreignWsId = foreignWs.id;
    const foreignDs = await prisma.datasource.create({
      data: { oid: foreignWsId, name: 'e2e-foreign-ds', type: 'sqlite' },
    });
    foreignDsId = foreignDs.id;
  });

  afterAll(async () => {
    await prisma.datasourceRelationVersion
      .deleteMany({ where: { datasourceId: dsId } })
      .catch(() => undefined);
    await prisma.datasource
      .update({ where: { id: dsId }, data: { tableRelation: [] } })
      .catch(() => undefined);
    await prisma.datasource
      .delete({ where: { id: dsId } })
      .catch(() => undefined);
    if (foreignDsId) {
      await prisma.datasource
        .delete({ where: { id: foreignDsId } })
        .catch(() => undefined);
    }
    if (foreignWsId) {
      await prisma.workspace
        .delete({ where: { id: foreignWsId } })
        .catch(() => undefined);
    }
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('appends a snapshot per save and returns history newest-first', async () => {
    const first = [{ id: 'e1', shape: 'edge' }];
    const second = [
      { id: 'e1', shape: 'edge' },
      { id: 'e2', shape: 'edge' },
    ];

    const save1 = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/save/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send(first);
    expect(save1.status).toBe(200);
    expect((save1.body as ApiEnvelope<{ version: number }>).data.version).toBe(
      1,
    );

    const save2 = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/save/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send(second);
    expect(save2.status).toBe(200);
    expect((save2.body as ApiEnvelope<{ version: number }>).data.version).toBe(
      2,
    );

    const versions = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/versions/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect(versions.status).toBe(200);
    const page = (
      versions.body as ApiEnvelope<{
        data: Array<{ version: number; snapshot: unknown }>;
        total_count: number;
      }>
    ).data;
    const rows = page.data;
    expect(page.total_count).toBe(2);
    expect(rows.map((r) => r.version)).toEqual([2, 1]);
    expect(rows[0].snapshot).toEqual(second);
    expect(rows[1].snapshot).toEqual(first);

    // Runtime still reads the latest saved graph.
    const current = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/get/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect((current.body as ApiEnvelope<unknown>).data).toEqual(second);
  });

  it('requires the admin token', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/versions/${dsId}`)
      .send({});
    expect(res.status).toBe(401);
  });

  // ─── compare / restore (M3 follow-up) ─────────────────────────────────

  const edgeA = {
    fromTable: 'orders',
    fromField: 'user_id',
    toTable: 'users',
    toField: 'id',
  };
  const edgeB = {
    fromTable: 'orders',
    fromField: 'product_id',
    toTable: 'products',
    toField: 'id',
  };
  const compareVersions = { from: 0, to: 0 };

  it('compares a saved version against the newest snapshot by default', async () => {
    const saveA = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/save/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send([edgeA]);
    expect(saveA.status).toBe(200);
    compareVersions.from = (
      saveA.body as ApiEnvelope<{ version: number }>
    ).data.version;

    const saveB = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/save/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send([edgeA, edgeB]);
    expect(saveB.status).toBe(200);
    compareVersions.to = (
      saveB.body as ApiEnvelope<{ version: number }>
    ).data.version;

    const forward = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/compare/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({ from_version: compareVersions.from });
    expect(forward.status).toBe(200);
    expect((forward.body as ApiEnvelope<unknown>).data).toEqual({
      fromVersion: compareVersions.from,
      toVersion: compareVersions.to,
      added: [edgeB],
      removed: [],
    });

    // Explicit to_version works in either direction.
    const reverse = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/compare/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({
        from_version: compareVersions.to,
        to_version: compareVersions.from,
      });
    expect(reverse.status).toBe(200);
    expect((reverse.body as ApiEnvelope<unknown>).data).toEqual({
      fromVersion: compareVersions.to,
      toVersion: compareVersions.from,
      added: [],
      removed: [edgeB],
    });
  });

  it('restores a saved snapshot as a new version without rewriting history', async () => {
    const restoreAt = new Date();
    const restored = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/restore/${dsId}/${compareVersions.from}`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect(restored.status).toBe(200);
    const out = (
      restored.body as ApiEnvelope<{
        success: boolean;
        version: number;
        restoredFrom: number;
      }>
    ).data;
    expect(out).toMatchObject({
      success: true,
      restoredFrom: compareVersions.from,
    });
    expect(out.version).toBeGreaterThan(compareVersions.to);

    // Current graph is the restored snapshot; history is append-only.
    const current = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/get/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect((current.body as ApiEnvelope<unknown>).data).toEqual([edgeA]);

    const versions = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/versions/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({});
    const page = (
      versions.body as ApiEnvelope<{
        data: Array<{
          version: number;
          snapshot: unknown;
          note: string | null;
        }>;
      }>
    ).data;
    const rows = page.data;
    expect(rows[0].version).toBe(out.version);
    expect(rows[0].snapshot).toEqual([edgeA]);
    expect(rows[0].note).toContain(String(compareVersions.from));
    expect(rows.some((r) => r.version === compareVersions.to)).toBe(true);

    // Restore is audited (fire-and-forget write → bounded poll).
    const log = await waitFor(
      () =>
        prisma.systemLog.findFirst({
          where: {
            module: 'datasource',
            detail: '恢复表关系版本',
            createdAt: { gte: restoreAt },
          },
          orderBy: { id: 'desc' },
        }),
      (row) => row != null,
    );
    expect(log).not.toBeNull();
  });

  it('404s unknown versions for compare and restore', async () => {
    const compare = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/compare/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({ from_version: 9_999_999 });
    expect(compare.status).toBe(404);

    const restore = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/restore/${dsId}/9999999`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect(restore.status).toBe(404);
  });

  it('rejects members from compare and restore (403)', async () => {
    const compare = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/compare/${dsId}`)
      .set(TOKEN_HEADER, memberToken)
      .send({ from_version: compareVersions.from });
    expect(compare.status).toBe(403);

    const restore = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/restore/${dsId}/${compareVersions.from}`)
      .set(TOKEN_HEADER, memberToken)
      .send({});
    expect(restore.status).toBe(403);
  });

  it('404s a datasource outside the current workspace', async () => {
    await prisma.datasourceRelationVersion.create({
      data: { datasourceId: foreignDsId, version: 1, snapshot: [] },
    });

    const restore = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/restore/${foreignDsId}/1`)
      .set(TOKEN_HEADER, token)
      .send({});
    expect(restore.status).toBe(404);

    const compare = await request(app.getHttpServer())
      .post(`/api/v1/table_relation/compare/${foreignDsId}`)
      .set(TOKEN_HEADER, token)
      .send({ from_version: 1 });
    expect(compare.status).toBe(404);
  });
});
