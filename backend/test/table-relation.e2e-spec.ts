// Relation-graph versioning e2e (MetaDataImprove M3): every save appends an
// immutable snapshot; the current relation stays the latest save.
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

describe('Table relation versions (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let dsId: number;
  let createdDs = false;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);

    const existing = await prisma.datasource.findFirst({
      where: { oid: 1 },
      orderBy: { id: 'asc' },
    });
    if (existing) {
      dsId = existing.id;
    } else {
      const ds = await prisma.datasource.create({
        data: { oid: 1, name: 'e2e-relation-ds', type: 'sqlite' },
      });
      dsId = ds.id;
      createdDs = true;
    }
    await prisma.datasourceRelationVersion.deleteMany({
      where: { datasourceId: dsId },
    });
    await prisma.datasource.update({
      where: { id: dsId },
      data: { tableRelation: [], relationVersion: 0 },
    });
  });

  afterAll(async () => {
    await prisma.datasourceRelationVersion
      .deleteMany({ where: { datasourceId: dsId } })
      .catch(() => undefined);
    await prisma.datasource
      .update({ where: { id: dsId }, data: { tableRelation: [] } })
      .catch(() => undefined);
    if (createdDs) {
      await prisma.datasource
        .delete({ where: { id: dsId } })
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
    const rows = (
      versions.body as ApiEnvelope<
        Array<{ version: number; snapshot: unknown }>
      >
    ).data;
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
});
