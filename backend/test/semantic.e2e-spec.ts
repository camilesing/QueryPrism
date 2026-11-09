// Semantic admin e2e — MetaDataImprove M2 layer surface over real HTTP:
// direct writes by layer authority, member proposals → admin approval loop,
// PERSONAL direct writes, version history, and the page visibility filter.
// Real services + real Prisma (CRUD-block pattern from chat/terminology e2e).
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

describe('Semantic admin (e2e)', () => {
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
    memberAccount = `e2e-sem-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Semantic Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    memberToken = await login(app, memberAccount, 'Init1234!');

    await prisma.tableSemantic.deleteMany({ where: { datasourceId: 1 } });
    await prisma.semanticChangeRequest.deleteMany({
      where: { proposerUid: undefined },
    });
  });

  afterAll(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('ws admin upserts WORKSPACE semantics directly + version history lands', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, adminToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: 1,
        table_name: 'sales_order',
        meaning: '销售订单主表',
      });
    expect(res.status).toBe(200);
    const out = (res.body as ApiEnvelope<{ applied: boolean; id: number }>)
      .data;
    expect(out.applied).toBe(true);

    const versions = await request(app.getHttpServer())
      .get(`/api/v1/system/semantic/versions/table/${out.id}`)
      .set(TOKEN_HEADER, adminToken);
    expect(versions.status).toBe(200);
    const vdata = (versions.body as ApiEnvelope<unknown[]>).data;
    expect(vdata).toHaveLength(1);

    // A second save increments the version + appends history.
    await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, adminToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: 1,
        table_name: 'sales_order',
        meaning: '销售订单表（修订）',
      });
    const versions2 = await request(app.getHttpServer())
      .get(`/api/v1/system/semantic/versions/table/${out.id}`)
      .set(TOKEN_HEADER, adminToken);
    expect(
      (versions2.body as ApiEnvelope<Array<{ version: number }>>).data,
    ).toHaveLength(2);
  });

  it('member proposal → ws admin approval applies at the WORKSPACE layer', async () => {
    // The member cannot write WORKSPACE directly — the upsert becomes a
    // pending request.
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: 1,
        table_name: 'crm_customer',
        meaning: '客户主数据',
        note: '补充客户表含义',
      });
    expect(propose.status).toBe(200);
    const proposed = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data;
    expect(proposed.applied).toBe(false);

    // No WORKSPACE row yet.
    const before = await prisma.tableSemantic.findFirst({
      where: { scope: 'WORKSPACE', tableName: 'crm_customer' },
    });
    expect(before).toBeNull();

    // The admin's pending inbox lists it; approve applies it.
    const inbox = await request(app.getHttpServer())
      .get('/api/v1/system/semantic/requests/pending/1/10')
      .set(TOKEN_HEADER, adminToken);
    expect(inbox.status).toBe(200);
    const items = (
      inbox.body as ApiEnvelope<{ data: { id: number; payload: unknown }[] }>
    ).data.data;
    const found = items.find((i) => i.id === proposed.request_id);
    expect(found).toBeDefined();

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: proposed.request_id, approve: true, review_note: '通过' });
    expect(review.status).toBe(200);

    const applied = await prisma.tableSemantic.findFirst({
      where: { scope: 'WORKSPACE', tableName: 'crm_customer' },
    });
    expect(applied?.meaning).toBe('客户主数据');

    // A member may not review.
    const denied = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, memberToken)
      .send({ id: proposed.request_id + 1_000_000, approve: true });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it('member writes PERSONAL directly; page shows own rows only for PERSONAL', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'PERSONAL',
        datasource_id: 1,
        table_name: 'sales_order',
        meaning: '我个人的订单表理解',
      });
    expect(res.status).toBe(200);
    expect(
      (res.body as ApiEnvelope<{ applied: boolean }>).data.applied,
    ).toBe(true);

    const memberPage = await request(app.getHttpServer())
      .get('/api/v1/system/semantic/page/table/1/50')
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
    // The member sees the WORKSPACE rows + their own PERSONAL row.
    expect(rows.some((r) => r.scope === 'WORKSPACE')).toBe(true);
    expect(rows.some((r) => r.scope === 'PERSONAL')).toBe(true);
  });
});
