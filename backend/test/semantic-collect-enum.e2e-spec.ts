// Dimension-enum collection e2e (MetaDataImprove M3.3) — the real HTTP path
// over a live SQLite datasource: one bounded DISTINCT probe per visible
// dimension field, backfill only where the actor may edit directly, curated
// label preservation, cardinality/dangling skips and the per-datasource
// cooldown. Unit coverage for the branches lives in semantic.service.spec.ts;
// this suite proves auth, connector access, persistence and the wire summary.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { encryptFrontendConfig } from './../src/datasource/frontend-config-crypto';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface CollectItem {
  id: number;
  table_name: string;
  field_name: string;
  values?: number;
  reason?: string;
}

interface CollectSummary {
  collected: CollectItem[];
  skipped: CollectItem[];
}

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

describe('Semantic enum collection (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let wsAdminToken: string;
  let wsAdminUid = 0;
  let dsId = 0;
  let statusSemanticId = 0;
  let skuSemanticId = 0;
  let regionSemanticId = 0;

  const stamp = Date.now();
  const dbPath = `/tmp/test-enum-e2e-${stamp}.db`;
  const wsAdminAccount = `e2e-enum-admin-${stamp}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    adminToken = await login(app, 'admin', 'admin');

    // A live SQLite source: two low-cardinality dimensions (one of them also
    // curated with a label) and one 60-value column above the 50 cap.
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, region TEXT, sku TEXT)',
    );
    const insert = db.prepare(
      'INSERT INTO orders (id, status, region, sku) VALUES (?, ?, ?, ?)',
    );
    const regions = ['east', 'west', 'north'];
    for (let i = 0; i < 60; i++) {
      insert.run(
        i + 1,
        i % 2 === 0 ? 'paid' : 'refunded',
        regions[i % regions.length],
        `sku_${i}`,
      );
    }
    // A NULL status must not become an enum member.
    insert.run(61, null, null, 'sku_0');
    db.close();

    const created = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, adminToken)
      .send({
        name: `e2e-enum-ds-${stamp}`,
        description: 'enum collection e2e',
        type: 'sqlite',
        configuration: encryptFrontendConfig({ db: dbPath }),
      });
    expect(created.status).toBe(200);
    dsId = (created.body as ApiEnvelope<{ id: number }>).data.id;

    const chosen = await request(app.getHttpServer())
      .post(`/api/v1/datasource/chooseTables/${dsId}`)
      .set(TOKEN_HEADER, adminToken)
      .send([{ table_name: 'orders', table_comment: '订单表' }]);
    expect(chosen.status).toBe(200);

    // A workspace admin (weight 1) runs the collection: WORKSPACE rows are
    // editable, GLOBAL rows fall under the approval round.
    const createdUser = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: wsAdminAccount,
        password: 'Init1234!',
        email: `${wsAdminAccount}@e2e.test`,
        name: 'Enum Ws Admin',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    expect(createdUser.status).toBe(200);
    wsAdminUid = (
      await prisma.user.findUniqueOrThrow({
        where: { account: wsAdminAccount },
      })
    ).id;
    const promoted = await request(app.getHttpServer())
      .put('/api/v1/system/workspace/uws')
      .set(TOKEN_HEADER, adminToken)
      .send({ uid: wsAdminUid, oid: 1, weight: 1 });
    expect(promoted.status).toBe(200);
    wsAdminToken = await login(app, wsAdminAccount, 'Init1234!');

    const upsert = (token: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .put('/api/v1/system/semantic')
        .set(TOKEN_HEADER, token)
        .send(body);

    const statusRes = await upsert(wsAdminToken, {
      entity_type: 'field',
      scope: 'WORKSPACE',
      datasource_id: dsId,
      table_name: 'orders',
      field_name: 'status',
      role: 'dimension',
      meaning: '订单状态',
      enum_values: [{ value: 'paid', label: '已支付' }],
    });
    expect(statusRes.status).toBe(200);
    statusSemanticId = (statusRes.body as ApiEnvelope<{ id: number }>).data.id;

    const skuRes = await upsert(wsAdminToken, {
      entity_type: 'field',
      scope: 'WORKSPACE',
      datasource_id: dsId,
      table_name: 'orders',
      field_name: 'sku',
      role: 'dimension',
      meaning: '商品编码',
    });
    expect(skuRes.status).toBe(200);
    skuSemanticId = (skuRes.body as ApiEnvelope<{ id: number }>).data.id;

    // GLOBAL by uid 1 — the ws admin can see it but not edit it directly.
    const regionRes = await upsert(adminToken, {
      entity_type: 'field',
      scope: 'GLOBAL',
      datasource_id: dsId,
      table_name: 'orders',
      field_name: 'region',
      role: 'dimension',
      meaning: '区域',
    });
    expect(regionRes.status).toBe(200);
    regionSemanticId = (regionRes.body as ApiEnvelope<{ id: number }>).data.id;

    // Dangling semantics: a dropped column and a dropped table.
    for (const body of [
      {
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: dsId,
        table_name: 'orders',
        field_name: 'gone_col',
        role: 'dimension',
        meaning: '已删除字段',
      },
      {
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: dsId,
        table_name: 'gone_table',
        field_name: 'x',
        role: 'dimension',
        meaning: '已删除表',
      },
    ]) {
      const res = await upsert(wsAdminToken, body);
      expect(res.status).toBe(200);
    }
  });

  afterAll(async () => {
    await prisma.fieldSemantic
      .deleteMany({ where: { datasourceId: dsId } })
      .catch(() => undefined);
    if (dsId) {
      await prisma.datasource
        .delete({ where: { id: dsId } })
        .catch(() => undefined);
    }
    await prisma.user
      .deleteMany({ where: { account: wsAdminAccount } })
      .catch(() => undefined);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    await app.close();
  });

  it('backfills editable low-cardinality dimensions and skips the rest', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/system/semantic/collect_enum/${dsId}`)
      .set(TOKEN_HEADER, wsAdminToken);
    expect(res.status).toBe(200);
    const summary = (res.body as ApiEnvelope<CollectSummary>).data;

    expect(summary.collected).toHaveLength(1);
    const collected = summary.collected[0];
    expect(collected).toMatchObject({
      id: statusSemanticId,
      table_name: 'orders',
      field_name: 'status',
      values: 2,
    });

    expect(summary.skipped).toHaveLength(4);
    const byField = new Map(
      summary.skipped.map((s) => [`${s.table_name}.${s.field_name}`, s]),
    );
    expect(byField.get('orders.sku')?.reason).toMatch(/50|去重/);
    expect(byField.get('orders.region')?.reason).toMatch(
      /authority|approval|审批/,
    );
    expect(byField.get('orders.gone_col')?.reason).toMatch(/field|字段/);
    expect(byField.get('gone_table.x')?.reason).toMatch(/table|表/);

    // The collected row carries sorted values with the curated label kept.
    const statusRow = await prisma.fieldSemantic.findUniqueOrThrow({
      where: { id: statusSemanticId },
    });
    expect(statusRow.version).toBe(2);
    expect(statusRow.enumValues).toEqual([
      { value: 'paid', label: '已支付' },
      { value: 'refunded' },
    ]);

    const versions = await prisma.fieldSemanticVersion.findMany({
      where: { entityId: statusSemanticId },
      orderBy: { version: 'desc' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[0].changedBy).toBe(wsAdminUid);
    expect(versions[0].snapshot).toMatchObject({
      source: 'enum_collect',
      enumValues: [{ value: 'paid', label: '已支付' }, { value: 'refunded' }],
    });

    // Non-collected rows are untouched.
    const skuRow = await prisma.fieldSemantic.findUniqueOrThrow({
      where: { id: skuSemanticId },
    });
    expect(skuRow.version).toBe(1);
    expect(skuRow.enumValues).toBeNull();
    const regionRow = await prisma.fieldSemantic.findUniqueOrThrow({
      where: { id: regionSemanticId },
    });
    expect(regionRow.version).toBe(1);
    expect(regionRow.enumValues).toBeNull();
  });

  it('rate-limits an immediate rerun without writing another version', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/system/semantic/collect_enum/${dsId}`)
      .set(TOKEN_HEADER, wsAdminToken);
    expect(res.status).toBe(400);

    const statusRow = await prisma.fieldSemantic.findUniqueOrThrow({
      where: { id: statusSemanticId },
    });
    expect(statusRow.version).toBe(2);
    expect(
      await prisma.fieldSemanticVersion.count({
        where: { entityId: statusSemanticId },
      }),
    ).toBe(2);
  });
});
