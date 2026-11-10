// Semantic natural-key e2e — MetaDataImprove: the partial unique indexes from
// migration 20261110130000_semantic_natural_key_unique must reject duplicate
// rows per scope layer, and concurrent API upserts must converge on ONE entity
// row (loser retries as a versioned update) instead of duplicating.
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

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Semantic natural-key uniqueness (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);
    await prisma.tableSemantic.deleteMany({ where: { datasourceId: 1 } });
    await prisma.fieldSemantic.deleteMany({ where: { datasourceId: 1 } });
    await prisma.metricDef.deleteMany({});
    await prisma.dataStandard.deleteMany({});
  });

  afterAll(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    await prisma.fieldSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    await prisma.metricDef.deleteMany({}).catch(() => undefined);
    await prisma.dataStandard.deleteMany({}).catch(() => undefined);
    await app.close();
  });

  it('rejects duplicate TableSemantic rows inside one scope layer only', async () => {
    const base = { datasourceId: 1, tableName: 'uniq_tbl' };
    await prisma.tableSemantic.create({
      data: {
        scope: 'GLOBAL',
        oid: null,
        ownerUid: null,
        ...base,
        meaning: 'global',
      },
    });
    await expect(
      prisma.tableSemantic.create({
        data: {
          scope: 'GLOBAL',
          oid: null,
          ownerUid: null,
          ...base,
          meaning: 'global-dup',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        ...base,
        meaning: 'workspace',
      },
    });
    await expect(
      prisma.tableSemantic.create({
        data: {
          scope: 'WORKSPACE',
          oid: 1,
          ownerUid: null,
          ...base,
          meaning: 'workspace-dup',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // PERSONAL is unique per owner; another user's layer may hold the same key.
    await prisma.tableSemantic.create({
      data: {
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 1,
        ...base,
        meaning: 'personal-1',
      },
    });
    await prisma.tableSemantic.create({
      data: {
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 7,
        ...base,
        meaning: 'personal-7',
      },
    });
    await expect(
      prisma.tableSemantic.create({
        data: {
          scope: 'PERSONAL',
          oid: 1,
          ownerUid: 7,
          ...base,
          meaning: 'personal-7-dup',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await prisma.tableSemantic.findMany({
      where: { datasourceId: 1, tableName: 'uniq_tbl' },
    });
    expect(rows).toHaveLength(4);
  });

  it('rejects duplicate FieldSemantic rows inside one scope layer', async () => {
    const data = {
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      datasourceId: 1,
      tableName: 'uniq_tbl',
      fieldName: 'uniq_col',
      role: 'dimension',
      meaning: 'dim',
    };
    await prisma.fieldSemantic.create({ data });
    await expect(prisma.fieldSemantic.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('rejects duplicate MetricDef / DataStandard codes inside one layer', async () => {
    const metric = {
      kind: 'period',
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      code: 'uniq_period',
      name: '并发周期',
      definition: { mode: 'anchor', anchor: 'month_start' },
    };
    await prisma.metricDef.create({ data: metric });
    await expect(
      prisma.metricDef.create({ data: metric }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const standard = {
      kind: 'unit',
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      code: 'uniq_unit',
      term: '件',
      name: '件',
      category: 'count',
    };
    await prisma.dataStandard.create({ data: standard });
    await expect(
      prisma.dataStandard.create({ data: standard }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('concurrent semantic upserts converge on one row with two versions', async () => {
    const payload = {
      entity_type: 'table',
      scope: 'WORKSPACE',
      datasource_id: 1,
      table_name: 'uniq_concurrent',
      meaning: '并发语义 A',
    };
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .put('/api/v1/system/semantic')
        .set(TOKEN_HEADER, token)
        .send(payload),
      request(app.getHttpServer())
        .put('/api/v1/system/semantic')
        .set(TOKEN_HEADER, token)
        .send({ ...payload, meaning: '并发语义 B' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await prisma.tableSemantic.findMany({
      where: { datasourceId: 1, tableName: 'uniq_concurrent' },
    });
    expect(rows).toHaveLength(1);
    const versions = await prisma.tableSemanticVersion.findMany({
      where: { entityId: rows[0].id },
    });
    expect(versions).toHaveLength(2);
  });

  it('concurrent metric upserts converge on one row with two versions', async () => {
    const payload = {
      kind: 'atomic',
      scope: 'WORKSPACE',
      code: 'uniq_concurrent_metric',
      name: '并发指标 A',
      definition: {
        datasource_id: 1,
        table_name: 'sales_order',
        field_name: 'amount',
        aggregation: 'SUM',
      },
    };
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .put('/api/v1/system/metric')
        .set(TOKEN_HEADER, token)
        .send(payload),
      request(app.getHttpServer())
        .put('/api/v1/system/metric')
        .set(TOKEN_HEADER, token)
        .send({ ...payload, name: '并发指标 B' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await prisma.metricDef.findMany({
      where: {
        scope: 'WORKSPACE',
        kind: 'atomic',
        code: 'uniq_concurrent_metric',
      },
    });
    expect(rows).toHaveLength(1);
    const versions = await prisma.metricDefVersion.findMany({
      where: { entityId: rows[0].id },
    });
    expect(versions).toHaveLength(2);
  });
});
