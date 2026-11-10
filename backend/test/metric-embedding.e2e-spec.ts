// Metric vector index e2e — MetaDataImprove M4 follow-up: MetricDef.embedding
// + the derived vector_store."vec_metric_def" index stay in sync through the
// governance write hook and the null-embedding backfill.
//
// The embedding provider is stubbed (no external key in CI): `available` +
// a fixed 3-dim vector. pgvector itself is real (the e2e DB is a real
// PostgreSQL), so the assertions cover the actual raw upsert, not a mock.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { EmbeddingService } from './../src/embedding/embedding.service';
import { waitFor } from './helpers/wait-for';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';
/** VectorService rejects a dimension that does not match EMBEDDING_DIMENSION
 *  (the e2e .env sets 1536), so the stub must produce real-length vectors —
 *  a short one makes the upsert throw and rolls the Json write back. */
const VECTOR_DIM = Number(process.env.EMBEDDING_DIMENSION ?? 1536) || 1536;
const VECTOR = Array.from({ length: VECTOR_DIM }, () => 0.1);

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

describe('Metric vector index (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let memberToken: string;
  let prisma: PrismaService;
  let memberAccount: string;
  const embedding = {
    available: true,
    embed: jest.fn(() => Promise.resolve(VECTOR)),
    embedBatch: jest.fn((texts: string[]) =>
      Promise.resolve(texts.map(() => VECTOR)),
    ),
  };

  /** Row count of the derived vector table for one metric id (0 when the
   *  table has not been created yet — collection never touched). */
  const vectorRows = async (id: number): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
         FROM "vector_store"."vec_metric_def"
        WHERE id = $1`,
      id,
    );
    return rows[0]?.count ?? 0;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmbeddingService)
      .useValue(embedding)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    // Diagnostic: the stubbed provider must be the instance the services
    // received, or the index hook silently takes the real (unavailable) path.
    expect(app.get(EmbeddingService)).toBe(embedding as never);
    expect(app.get(EmbeddingService).available).toBe(true);
    adminToken = await login(app, 'admin', 'admin');

    // A normal member of workspace 1 (weight 0) proposes metric changes.
    memberAccount = `e2e-metricvec-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Metric Vector Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    memberToken = await login(app, memberAccount, 'Init1234!');

    await prisma.metricDef.deleteMany({
      where: { code: { startsWith: 'e2e_vec_' } },
    });
  });

  afterAll(async () => {
    await prisma.metricDef
      .deleteMany({ where: { code: { startsWith: 'e2e_vec_' } } })
      .catch(() => undefined);
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(() => {
    embedding.embedBatch.mockClear();
    embedding.embedBatch.mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => VECTOR)),
    );
  });

  const atomicPayload = (code: string) => ({
    kind: 'atomic',
    scope: 'WORKSPACE',
    code,
    name: '支付金额',
    aliases: ['支付额'],
    description: '订单实付金额合计',
    unit: '元',
    definition: {
      datasource_id: 1,
      table_name: 'sales_order',
      field_name: 'amount',
      aggregation: 'SUM',
    },
  });

  it('indexes a metric after its proposal is approved', async () => {
    const code = `e2e_vec_approved_${Date.now()}`;
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, memberToken)
      .send(atomicPayload(code));
    expect(propose.status).toBe(200);
    const requestId = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data.request_id;

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: requestId, approve: true });
    expect(review.status).toBe(200);

    // afterCommit is fire-and-forget: poll for the Json column first, then
    // assert the derived index row joined it.
    const row = await waitFor(
      () =>
        prisma.metricDef.findFirst({
          where: { scope: 'WORKSPACE', kind: 'atomic', code },
          select: { id: true, embedding: true },
        }),
      (r) => r?.embedding != null,
    );
    expect(row).not.toBeNull();
    expect(row!.embedding).toEqual(VECTOR);
    // the embedded text is name + aliases + description (no code/definition)
    expect(embedding.embedBatch).toHaveBeenCalledWith([
      '支付金额 支付额\n订单实付金额合计',
    ]);
    expect(await vectorRows(row!.id)).toBe(1);
  });

  it('a direct admin write is indexed the same way', async () => {
    const code = `e2e_vec_direct_${Date.now()}`;
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, adminToken)
      .send(atomicPayload(code));
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<{ applied: boolean }>).data.applied).toBe(
      true,
    );
    const row = await waitFor(
      () =>
        prisma.metricDef.findFirst({
          where: { scope: 'WORKSPACE', kind: 'atomic', code },
          select: { id: true, embedding: true },
        }),
      (r) => r?.embedding != null,
    );
    expect(row!.embedding).toEqual(VECTOR);
    expect(await vectorRows(row!.id)).toBe(1);
  });

  it('the manual backfill fills metric rows whose embedding is NULL', async () => {
    // A row written while no embedding key existed: Json NULL, no vector.
    const created = await prisma.metricDef.create({
      data: {
        kind: 'atomic',
        code: `e2e_vec_backfill_${Date.now()}`,
        name: '退款金额',
        aliases: [],
        description: null,
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
        scope: 'WORKSPACE',
        oid: 1,
        enabled: true,
      },
    });
    expect(created.embedding).toBeNull();

    const res = await request(app.getHttpServer())
      .post('/api/v1/embedding/backfill')
      .set(TOKEN_HEADER, adminToken);
    expect(res.status).toBe(201);
    const counts = (res.body as ApiEnvelope<{ metric: number }>).data;
    expect(counts.metric).toBeGreaterThanOrEqual(1);

    const filled = await prisma.metricDef.findUnique({
      where: { id: created.id },
      select: { embedding: true },
    });
    expect(filled?.embedding).toEqual(VECTOR);
    expect(await vectorRows(created.id)).toBe(1);
  });
});
