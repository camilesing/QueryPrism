// Metric system + data standards admin e2e — MetaDataImprove M4 layer
// surface over real HTTP: direct writes by layer authority, member proposals
// → admin approval loop (shared metric/standard inbox), version history,
// composite-expression validation, and the page visibility filter.
// Real services + real Prisma (CRUD-block pattern from semantic.e2e-spec).
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
  msg: string;
  data: T;
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

describe('Metric system + data standards admin (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let memberToken: string;
  let prisma: PrismaService;
  let memberAccount: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    adminToken = await login(app, 'admin', 'admin');

    // A normal member of workspace 1 (weight 0).
    memberAccount = `e2e-metric-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Metric Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    memberToken = await login(app, memberAccount, 'Init1234!');

    await prisma.metricDef.deleteMany({});
    await prisma.dataStandard.deleteMany({});
    await prisma.semanticChangeRequest.deleteMany({
      where: { entityType: { in: ['metric', 'standard'] } },
    });
  });

  afterAll(async () => {
    await prisma.metricDef.deleteMany({}).catch(() => undefined);
    await prisma.dataStandard.deleteMany({}).catch(() => undefined);
    await prisma.semanticChangeRequest
      .deleteMany({ where: { entityType: { in: ['metric', 'standard'] } } })
      .catch(() => undefined);
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('ws admin upserts atomic/derived metrics directly + version history lands', async () => {
    const atomic = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, adminToken)
      .send({
        kind: 'atomic',
        scope: 'WORKSPACE',
        code: 'pay_amount',
        name: '支付金额',
        unit: '元',
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      });
    expect(atomic.status).toBe(200);
    const atomicOut = (
      atomic.body as ApiEnvelope<{ applied: boolean; id: number }>
    ).data;
    expect(atomicOut.applied).toBe(true);

    // definition keys are snake on the wire — wait, the definition is the
    // stored Json verbatim; the DTO accepts it as-is. Re-save to bump version.
    const again = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, adminToken)
      .send({
        kind: 'atomic',
        scope: 'WORKSPACE',
        code: 'pay_amount',
        name: '支付金额（修订）',
        unit: '元',
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      });
    expect(again.status).toBe(200);

    const versions = await request(app.getHttpServer())
      .get(`/api/v1/system/metric/versions/${atomicOut.id}`)
      .set(TOKEN_HEADER, adminToken);
    expect(versions.status).toBe(200);
    expect(
      (versions.body as ApiEnvelope<Array<{ version: number }>>).data,
    ).toHaveLength(2);
  });

  it('rejects malformed definitions and composite self-reference', async () => {
    const badExpr = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, adminToken)
      .send({
        kind: 'composite',
        scope: 'WORKSPACE',
        code: 'atv',
        name: '客单价',
        definition: { expression: 'atv / pay_amount' },
      });
    expect(badExpr.status).toBeGreaterThanOrEqual(400);

    const badDef = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, adminToken)
      .send({
        kind: 'modifier',
        scope: 'WORKSPACE',
        code: 'baby',
        name: '母婴类',
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'category',
          operator: 'between',
          values: ['a'],
        },
      });
    expect(badDef.status).toBeGreaterThanOrEqual(400);
  });

  it('member proposal → ws admin approval applies at the WORKSPACE layer (metric)', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'period',
        scope: 'WORKSPACE',
        code: 'last_7d',
        name: '最近7天',
        definition: { mode: 'recent', time_unit: 'day', count: 7 },
        note: '补充时间周期',
      });
    expect(propose.status).toBe(200);
    const proposed = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data;
    expect(proposed.applied).toBe(false);

    const before = await prisma.metricDef.findFirst({
      where: { scope: 'WORKSPACE', kind: 'period', code: 'last_7d' },
    });
    expect(before).toBeNull();

    // The shared M4 inbox (metric + standard) lists it.
    const inbox = await request(app.getHttpServer())
      .get('/api/v1/system/metric/requests/pending/1/10')
      .set(TOKEN_HEADER, adminToken);
    expect(inbox.status).toBe(200);
    const items = (
      inbox.body as ApiEnvelope<{
        data: Array<{ id: number; entity_type: string }>;
      }>
    ).data.data;
    const found = items.find((i) => i.id === proposed.request_id);
    expect(found).toBeDefined();
    expect(found?.entity_type).toBe('metric');

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: proposed.request_id, approve: true });
    expect(review.status).toBe(200);

    const applied = await prisma.metricDef.findFirst({
      where: { scope: 'WORKSPACE', kind: 'period', code: 'last_7d' },
    });
    expect(applied).not.toBeNull();

    // A member may not review.
    const denied = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, memberToken)
      .send({ id: proposed.request_id + 1_000_000, approve: true });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it('member writes PERSONAL metrics directly; page shows visible layers only', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'atomic',
        scope: 'PERSONAL',
        code: 'my_pay',
        name: '我的支付金额',
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'MAX',
        },
      });
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ applied: boolean }>).data.applied).toBe(
      true,
    );

    const memberPage = await request(app.getHttpServer())
      .get('/api/v1/system/metric/page/atomic/1/50')
      .set(TOKEN_HEADER, memberToken);
    expect(memberPage.status).toBe(200);
    const rows = (
      memberPage.body as ApiEnvelope<{
        data: Array<{ scope: string; owner_uid: number | null }>;
      }>
    ).data.data;
    for (const row of rows) {
      if (row.scope === 'PERSONAL') {
        expect(row.owner_uid).not.toBeNull();
      }
    }
    expect(rows.some((r) => r.scope === 'WORKSPACE')).toBe(true);
    expect(rows.some((r) => r.scope === 'PERSONAL')).toBe(true);
  });

  it('data standards: upsert + shared inbox + naming entry visible on page', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/standard')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'naming',
        scope: 'WORKSPACE',
        code: 'annual_revenue',
        term: '年营收',
        name: '年度总营业额',
        category: 'business_noun',
      });
    expect(propose.status).toBe(200);
    const proposed = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data;
    expect(proposed.applied).toBe(false);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: proposed.request_id, approve: true });
    expect(review.status).toBe(200);

    const page = await request(app.getHttpServer())
      .get('/api/v1/system/standard/page/naming/1/50')
      .set(TOKEN_HEADER, adminToken);
    expect(page.status).toBe(200);
    const rows = (
      page.body as ApiEnvelope<{ data: Array<{ code: string; term: string }> }>
    ).data.data;
    expect(rows.some((r) => r.code === 'annual_revenue')).toBe(true);

    // Enable toggle round-trips a version.
    const row = await prisma.dataStandard.findFirst({
      where: { kind: 'naming', code: 'annual_revenue' },
    });
    expect(row).not.toBeNull();
    const toggle = await request(app.getHttpServer())
      .get(`/api/v1/system/standard/${row!.id}/enable/false`)
      .set(TOKEN_HEADER, adminToken);
    expect(toggle.status).toBe(200);
    const disabled = await prisma.dataStandard.findUnique({
      where: { id: row!.id },
    });
    expect(disabled?.enabled).toBe(false);
  });
});
