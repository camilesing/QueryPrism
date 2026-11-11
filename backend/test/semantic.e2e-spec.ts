// Semantic admin e2e — MetaDataImprove M2 layer surface over real HTTP:
// direct writes by layer authority, member proposals → admin approval loop,
// PERSONAL direct writes, version history, and the page visibility filter.
// Real services + real Prisma (CRUD-block pattern from chat/terminology e2e).
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { requestContextStorage } from './../src/common/context/request-context';
import { SemanticService } from './../src/semantic/semantic.service';

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
  let memberUid = 0;

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
    memberUid = (
      await prisma.user.findUniqueOrThrow({
        where: { account: memberAccount },
        select: { id: true },
      })
    ).id;

    await prisma.tableSemantic.deleteMany({ where: { datasourceId: 1 } });
  });

  afterAll(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    // Requests have no FK to the user; clean up only this suite's proposals.
    await prisma.semanticChangeRequest
      .deleteMany({ where: { proposerUid: memberUid } })
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

    // A member may not review: create a FRESH pending WORKSPACE proposal (the
    // approved one above would fail the status check first and prove nothing).
    const pending = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: 1,
        table_name: 'crm_customer_denied',
        meaning: '待审批的客户表',
      });
    const pendingId = (pending.body as ApiEnvelope<{ request_id: number }>).data
      .request_id;
    const denied = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, memberToken)
      .send({ id: pendingId, approve: true });
    expect(denied.status).toBe(403);
  });

  it('two concurrent approvals apply the proposal exactly once', async () => {
    const tableName = `e2e_concurrent_${Date.now()}`;
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: 1,
        table_name: tableName,
        meaning: '并发审批目标',
      });
    expect(propose.status).toBe(200);
    const requestId = (propose.body as ApiEnvelope<{ request_id: number }>).data
      .request_id;

    // True concurrency: two HTTP requests mostly SERIALISE at review()'s
    // pre-read (the second sees `approved` and never reaches the claim), which
    // would not exercise the guard. Calling the service in one tick makes both
    // pre-reads race, so the conditional updateMany(status='pending') decides.
    const service = app.get(SemanticService);
    const admin = {
      id: 1,
      account: 'admin',
      oid: 1,
      language: 'zh-CN',
      weight: 1,
    };
    const races = await Promise.allSettled([
      requestContextStorage.run({ user: admin }, () =>
        service.review(requestId, true, '并发 A'),
      ),
      requestContextStorage.run({ user: admin }, () =>
        service.review(requestId, true, '并发 B'),
      ),
    ]);
    expect(races.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = races.find((r) => r.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
    }

    const applied = await prisma.tableSemantic.findFirst({
      where: { scope: 'WORKSPACE', tableName },
    });
    expect(applied).not.toBeNull();
    // A double apply would have appended a second version snapshot.
    const versions = await prisma.tableSemanticVersion.count({
      where: { entityId: applied!.id },
    });
    expect(versions).toBe(1);
    const closed = await prisma.semanticChangeRequest.findUnique({
      where: { id: requestId },
    });
    expect(closed?.status).toBe('approved');

    // A repeat click over HTTP reports "not pending" instead of re-applying.
    const again = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: requestId, approve: true });
    expect(again.status).toBe(400);
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
    expect((res.body as ApiEnvelope<{ applied: boolean }>).data.applied).toBe(
      true,
    );

    // A different user's PERSONAL row must be invisible to the member.
    await prisma.tableSemantic.create({
      data: {
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 1,
        datasourceId: 1,
        tableName: 'admin_private',
        meaning: '管理员私有语义',
        enabled: true,
      },
    });

    const memberPage = await request(app.getHttpServer())
      .get('/api/v1/system/semantic/page/table/1/50')
      .set(TOKEN_HEADER, memberToken);
    expect(memberPage.status).toBe(200);
    const rows = (
      memberPage.body as ApiEnvelope<{
        data: Array<{
          scope: string;
          owner_uid: number | null;
          table_name: string;
        }>;
      }>
    ).data.data;
    expect(rows.some((r) => r.table_name === 'admin_private')).toBe(false);
    for (const row of rows) {
      if (row.scope === 'PERSONAL') {
        expect(row.owner_uid).toBe(memberUid);
      }
    }
    // The member sees the WORKSPACE rows + their own PERSONAL row.
    expect(rows.some((r) => r.scope === 'WORKSPACE')).toBe(true);
    expect(rows.some((r) => r.scope === 'PERSONAL')).toBe(true);
  });
});
