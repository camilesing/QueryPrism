// GLOBAL approval flow e2e (MetaDataImprove M2/M4) — the layer that no other
// suite covers: a lower-layer actor can only PROPOSE a GLOBAL row, a
// workspace admin can neither see nor approve it, and uid 1's approval
// applies the payload + version history in one transaction. Covers table and
// field semantics plus the shared governed dictionaries (metric / standard).
// Sequential assertions only — concurrent double-approval is a known gap
// tracked separately, not asserted here.
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

interface UpsertResult {
  applied: boolean;
  id?: number;
  request_id?: number;
}

interface RequestRow {
  id: number;
  entity_type: string;
  action: string;
  target_type: string;
  status: string;
  proposer_uid: number;
  reviewer_uid: number | null;
  review_note: string | null;
  reviewed_at: string | null;
}

interface VersionRow {
  version: number;
  snapshot: { source?: string };
  changed_by: number | null;
  note: string | null;
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

describe('GLOBAL approval flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let memberToken: string;
  let wsAdminToken: string;
  let memberUid = 0;
  let wsAdminUid = 0;

  const stamp = Date.now();
  const prefix = `e2e_global_${stamp}`;
  const tableName = `${prefix}_tbl`;
  const fieldName = 'status';
  const rejectTable = `${prefix}_reject`;
  const metricCode = `${prefix}_metric`;
  const standardCode = `${prefix}_naming`;
  const memberAccount = `e2e-global-member-${stamp}`;
  const wsAdminAccount = `e2e-global-wsadmin-${stamp}`;
  const suiteStart = new Date();

  async function pendingInbox(
    token: string,
    path: string,
  ): Promise<RequestRow[]> {
    const res = await request(app.getHttpServer())
      .get(path)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    return (res.body as ApiEnvelope<{ data: RequestRow[] }>).data.data;
  }

  async function versionsOf(
    token: string,
    path: string,
  ): Promise<VersionRow[]> {
    const res = await request(app.getHttpServer())
      .get(path)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    return (res.body as ApiEnvelope<VersionRow[]>).data;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    adminToken = await login(app, 'admin', 'admin');

    for (const [account, name] of [
      [memberAccount, 'Global Member'],
      [wsAdminAccount, 'Global Ws Admin'],
    ]) {
      const created = await request(app.getHttpServer())
        .post('/api/v1/user')
        .set(TOKEN_HEADER, adminToken)
        .send({
          account,
          password: 'Init1234!',
          email: `${account}@e2e.test`,
          name,
          oid: 1,
          oid_list: [1],
          status: 1,
        });
      expect(created.status).toBe(200);
    }
    memberUid = (
      await prisma.user.findUniqueOrThrow({ where: { account: memberAccount } })
    ).id;
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

    memberToken = await login(app, memberAccount, 'Init1234!');
    wsAdminToken = await login(app, wsAdminAccount, 'Init1234!');
  });

  afterAll(async () => {
    await prisma.semanticChangeRequest
      .deleteMany({ where: { createdAt: { gte: suiteStart } } })
      .catch(() => undefined);
    await prisma.tableSemantic
      .deleteMany({ where: { tableName: { startsWith: prefix } } })
      .catch(() => undefined);
    await prisma.fieldSemantic
      .deleteMany({ where: { tableName: { startsWith: prefix } } })
      .catch(() => undefined);
    await prisma.metricDef
      .deleteMany({ where: { code: { startsWith: prefix } } })
      .catch(() => undefined);
    await prisma.dataStandard
      .deleteMany({ where: { code: { startsWith: prefix } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({
        where: { account: { in: [memberAccount, wsAdminAccount] } },
      })
      .catch(() => undefined);
    await app.close();
  });

  it('member proposes a GLOBAL table semantic; nothing is applied yet', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'GLOBAL',
        datasource_id: 1,
        table_name: tableName,
        meaning: '全局客户表含义',
        note: '成员提案',
      });
    expect(propose.status).toBe(200);
    const out = (propose.body as ApiEnvelope<UpsertResult>).data;
    expect(out.applied).toBe(false);
    expect(out.request_id).toBeDefined();

    // No GLOBAL row exists before approval.
    expect(
      await prisma.tableSemantic.findFirst({
        where: { scope: 'GLOBAL', tableName },
      }),
    ).toBeNull();

    const reqRow = await prisma.semanticChangeRequest.findUniqueOrThrow({
      where: { id: out.request_id! },
    });
    expect(reqRow.targetType).toBe('GLOBAL');
    expect(reqRow.status).toBe('pending');
    expect(reqRow.proposerUid).toBe(memberUid);
    expect(reqRow.oid).toBe(1);

    // The proposer sees it in their "mine" inbox.
    const mine = await pendingInbox(
      memberToken,
      '/api/v1/system/semantic/requests/mine/1/50',
    );
    const own = mine.find((r) => r.id === out.request_id);
    expect(own?.target_type).toBe('GLOBAL');
    expect(own?.status).toBe('pending');
  });

  it('workspace admin neither sees nor reviews a GLOBAL request', async () => {
    const reqRow = await prisma.semanticChangeRequest.findFirstOrThrow({
      where: { targetType: 'GLOBAL', proposerUid: memberUid },
      orderBy: { id: 'desc' },
    });

    const wsInbox = await pendingInbox(
      wsAdminToken,
      '/api/v1/system/semantic/requests/pending/1/50',
    );
    expect(wsInbox.some((r) => r.id === reqRow.id)).toBe(false);

    const wsReview = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, wsAdminToken)
      .send({ id: reqRow.id, approve: true });
    expect(wsReview.status).toBe(403);

    const memberReview = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, memberToken)
      .send({ id: reqRow.id, approve: true });
    expect(memberReview.status).toBe(403);
  });

  it('uid 1 approval applies the GLOBAL row + version history in one step', async () => {
    const reqRow = await prisma.semanticChangeRequest.findFirstOrThrow({
      where: {
        targetType: 'GLOBAL',
        proposerUid: memberUid,
        status: 'pending',
      },
      orderBy: { id: 'desc' },
    });

    const inbox = await pendingInbox(
      adminToken,
      '/api/v1/system/semantic/requests/pending/1/50',
    );
    expect(inbox.some((r) => r.id === reqRow.id)).toBe(true);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: reqRow.id, approve: true, review_note: '全局审批通过' });
    expect(review.status).toBe(200);

    const row = await prisma.tableSemantic.findFirstOrThrow({
      where: { scope: 'GLOBAL', tableName },
    });
    expect(row.oid).toBeNull();
    expect(row.ownerUid).toBeNull();
    expect(row.version).toBe(1);
    expect(row.meaning).toBe('全局客户表含义');

    const versions = await versionsOf(
      adminToken,
      `/api/v1/system/semantic/versions/table/${row.id}`,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot.source).toBe('create');
    expect(versions[0].changed_by).toBe(1);
    expect(versions[0].note).toBe('全局审批通过');

    const closed = await prisma.semanticChangeRequest.findUniqueOrThrow({
      where: { id: reqRow.id },
    });
    expect(closed.status).toBe('approved');
    expect(closed.reviewerUid).toBe(1);
    expect(closed.reviewNote).toBe('全局审批通过');
    expect(closed.reviewedAt).not.toBeNull();

    // A member sees the approved GLOBAL row in their admin page.
    const page = await request(app.getHttpServer())
      .get('/api/v1/system/semantic/page/table/1/100')
      .set(TOKEN_HEADER, memberToken);
    expect(page.status).toBe(200);
    const rows = (
      page.body as ApiEnvelope<{
        data: Array<{ scope: string; table_name: string }>;
      }>
    ).data.data;
    expect(
      rows.some((r) => r.scope === 'GLOBAL' && r.table_name === tableName),
    ).toBe(true);
  });

  it('rejects a second review of an already-closed request (400)', async () => {
    const closed = await prisma.semanticChangeRequest.findFirstOrThrow({
      where: {
        targetType: 'GLOBAL',
        proposerUid: memberUid,
        status: 'approved',
      },
      orderBy: { id: 'desc' },
    });
    const again = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: closed.id, approve: true });
    expect(again.status).toBe(400);
  });

  it('a later GLOBAL update approval bumps the version and records an edit', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'GLOBAL',
        datasource_id: 1,
        table_name: tableName,
        meaning: '全局客户表含义 v2',
      });
    expect(propose.status).toBe(200);
    const proposed = (propose.body as ApiEnvelope<UpsertResult>).data;
    expect(proposed.applied).toBe(false);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({
        id: proposed.request_id,
        approve: true,
        review_note: '二次通过',
      });
    expect(review.status).toBe(200);

    const row = await prisma.tableSemantic.findFirstOrThrow({
      where: { scope: 'GLOBAL', tableName },
    });
    expect(row.version).toBe(2);
    expect(row.meaning).toBe('全局客户表含义 v2');

    const versions = await versionsOf(
      adminToken,
      `/api/v1/system/semantic/versions/table/${row.id}`,
    );
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[0].snapshot.source).toBe('edit');
    expect(versions[0].changed_by).toBe(1);
  });

  it('approves a GLOBAL field semantic with reviewer attribution', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'field',
        scope: 'GLOBAL',
        datasource_id: 1,
        table_name: tableName,
        field_name: fieldName,
        role: 'dimension',
        meaning: '全局状态维度',
      });
    expect(propose.status).toBe(200);
    const proposed = (propose.body as ApiEnvelope<UpsertResult>).data;
    expect(proposed.applied).toBe(false);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: proposed.request_id, approve: true });
    expect(review.status).toBe(200);

    const row = await prisma.fieldSemantic.findFirstOrThrow({
      where: { scope: 'GLOBAL', tableName, fieldName },
    });
    expect(row.oid).toBeNull();
    expect(row.version).toBe(1);

    const versions = await versionsOf(
      adminToken,
      `/api/v1/system/semantic/versions/field/${row.id}`,
    );
    expect(versions[0].snapshot.source).toBe('create');
    expect(versions[0].changed_by).toBe(1);
  });

  it('approves a GLOBAL remove proposal and deletes the row', async () => {
    const row = await prisma.tableSemantic.findFirstOrThrow({
      where: { scope: 'GLOBAL', tableName },
    });

    const remove = await request(app.getHttpServer())
      .delete('/api/v1/system/semantic')
      .query({ entity_type: 'table' })
      .set(TOKEN_HEADER, memberToken)
      .send([row.id]);
    expect(remove.status).toBe(200);
    expect(
      (remove.body as ApiEnvelope<{ removed: number; requested: number }>).data,
    ).toEqual({ removed: 0, requested: 1 });

    const pending = await prisma.semanticChangeRequest.findFirstOrThrow({
      where: { targetType: 'GLOBAL', action: 'remove', status: 'pending' },
      orderBy: { id: 'desc' },
    });
    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: pending.id, approve: true });
    expect(review.status).toBe(200);

    expect(
      await prisma.tableSemantic.findFirst({
        where: { scope: 'GLOBAL', tableName },
      }),
    ).toBeNull();
  });

  it('rejects a GLOBAL proposal without applying it; the member may propose again', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'GLOBAL',
        datasource_id: 1,
        table_name: rejectTable,
        meaning: '将被拒绝的全局含义',
      });
    expect(propose.status).toBe(200);
    const proposed = (propose.body as ApiEnvelope<UpsertResult>).data;

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({
        id: proposed.request_id,
        approve: false,
        review_note: '不符合规范',
      });
    expect(review.status).toBe(200);

    expect(
      await prisma.tableSemantic.findFirst({
        where: { scope: 'GLOBAL', tableName: rejectTable },
      }),
    ).toBeNull();
    const closed = await prisma.semanticChangeRequest.findUniqueOrThrow({
      where: { id: proposed.request_id! },
    });
    expect(closed.status).toBe('rejected');
    expect(closed.reviewNote).toBe('不符合规范');

    // A rejected proposal no longer blocks the same natural key.
    const again = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'GLOBAL',
        datasource_id: 1,
        table_name: rejectTable,
        meaning: '修改后的全局含义',
      });
    expect(again.status).toBe(200);
    const reproposed = (again.body as ApiEnvelope<UpsertResult>).data;
    expect(reproposed.applied).toBe(false);
    expect(reproposed.request_id).not.toBe(proposed.request_id);
  });

  it('routes a GLOBAL metric through the shared metric inbox (ws admin cannot review)', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'period',
        scope: 'GLOBAL',
        code: metricCode,
        name: '全局时间周期',
        definition: { mode: 'recent', time_unit: 'day', count: 7 },
        note: '指标提案',
      });
    expect(propose.status).toBe(200);
    const proposed = (propose.body as ApiEnvelope<UpsertResult>).data;
    expect(proposed.applied).toBe(false);

    const wsInbox = await pendingInbox(
      wsAdminToken,
      '/api/v1/system/metric/requests/pending/1/50',
    );
    expect(wsInbox.some((r) => r.id === proposed.request_id)).toBe(false);

    const denied = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, wsAdminToken)
      .send({ id: proposed.request_id, approve: true });
    expect(denied.status).toBe(403);

    const adminInbox = await pendingInbox(
      adminToken,
      '/api/v1/system/metric/requests/pending/1/50',
    );
    const found = adminInbox.find((r) => r.id === proposed.request_id);
    expect(found?.entity_type).toBe('metric');

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({
        id: proposed.request_id,
        approve: true,
        review_note: '指标通过',
      });
    expect(review.status).toBe(200);

    const row = await prisma.metricDef.findFirstOrThrow({
      where: { scope: 'GLOBAL', code: metricCode },
    });
    expect(row.oid).toBeNull();
    expect(row.version).toBe(1);

    const versions = await versionsOf(
      adminToken,
      `/api/v1/system/metric/versions/${row.id}`,
    );
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot.source).toBe('create');
    expect(versions[0].changed_by).toBe(1);
  });

  it('routes a GLOBAL data standard through the shared inbox to uid 1', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/standard')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'naming',
        scope: 'GLOBAL',
        code: standardCode,
        term: '全局年营收',
        name: '全局年度总营业额',
        category: 'business_noun',
      });
    expect(propose.status).toBe(200);
    const proposed = (propose.body as ApiEnvelope<UpsertResult>).data;
    expect(proposed.applied).toBe(false);

    const adminInbox = await pendingInbox(
      adminToken,
      '/api/v1/system/metric/requests/pending/1/50',
    );
    const found = adminInbox.find((r) => r.id === proposed.request_id);
    expect(found?.entity_type).toBe('standard');

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: proposed.request_id, approve: true });
    expect(review.status).toBe(200);

    const row = await prisma.dataStandard.findFirstOrThrow({
      where: { scope: 'GLOBAL', code: standardCode },
    });
    expect(row.oid).toBeNull();
    expect(row.version).toBe(1);

    const versions = await versionsOf(
      adminToken,
      `/api/v1/system/standard/versions/${row.id}`,
    );
    expect(versions[0].snapshot.source).toBe('create');
    expect(versions[0].changed_by).toBe(1);
  });
});
