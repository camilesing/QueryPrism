// Metadata sync e2e (MetaDataImprove M5): admin CRUD + manual run against a
// local HTTP endpoint, secret masking, auth header forwarding, run history.
import { createServer, type Server } from 'node:http';
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

interface SourceSnake {
  id: number;
  name: string;
  has_auth: boolean;
  enabled: boolean;
  last_status: string | null;
}

interface RunResult {
  run_id: number;
  status: string;
  applied: number;
  failed_count: number;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Metadata sync (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let server: Server;
  let endpoint = '';
  let rows: unknown[] = [];
  let lastHeaders: Record<string, unknown> = {};
  let memberToken = '';
  let memberAccount = '';
  const suffix = Date.now();

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastHeaders = req.headers;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(rows));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    endpoint = `http://127.0.0.1:${port}/rows`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);
    // A plain member of workspace 1: WsAdminGuard must reject them even
    // though JwtAuthGuard authenticates successfully.
    memberAccount = `e2e-sync-member-${suffix}`;
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Metadata Sync Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: memberAccount, password: 'Init1234!' });
    memberToken = (loginRes.body as ApiEnvelope<{ access_token: string }>).data
      .access_token;
    await prisma.metadataSyncSource.deleteMany({
      where: { oid: 1, name: { startsWith: 'e2e-sync-' } },
    });
    await prisma.tableSemantic.deleteMany({
      where: { datasourceId: 1, tableName: { startsWith: 'sync_' } },
    });
  });

  afterAll(async () => {
    await prisma.metadataSyncSource
      .deleteMany({ where: { oid: 1, name: { startsWith: 'e2e-sync-' } } })
      .catch(() => undefined);
    await prisma.tableSemantic
      .deleteMany({
        where: { datasourceId: 1, tableName: { startsWith: 'sync_' } },
      })
      .catch(() => undefined);
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const createSource = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/system/metadata-sync')
      .set(TOKEN_HEADER, token)
      .send(body);

  it('requires an admin token', async () => {
    const unauthenticated = await request(app.getHttpServer()).get(
      '/api/v1/system/metadata-sync',
    );
    expect(unauthenticated.status).toBe(401);

    // Authenticated weight-0 member: JwtAuthGuard passes, WsAdminGuard 403s.
    const member = await request(app.getHttpServer())
      .get('/api/v1/system/metadata-sync')
      .set(TOKEN_HEADER, memberToken);
    expect(member.status).toBe(403);

    const memberCreate = await request(app.getHttpServer())
      .post('/api/v1/system/metadata-sync')
      .set(TOKEN_HEADER, memberToken)
      .send({
        name: `e2e-sync-${suffix}-member`,
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint,
      });
    expect(memberCreate.status).toBe(403);
  });

  it('creates a source, runs it, imports rows and records history', async () => {
    rows = [
      {
        entity_type: 'table',
        datasource_id: 1,
        table_name: 'sync_order',
        meaning: '外部同步的订单表',
      },
    ];
    const created = await createSource({
      name: `e2e-sync-${suffix}-a`,
      kind: 'HTTP_API',
      target: 'semantic',
      endpoint,
      http_method: 'GET',
      enabled: true,
    });
    expect(created.status).toBe(200);
    const source = (created.body as ApiEnvelope<SourceSnake>).data;
    expect(source.has_auth).toBe(false);
    expect(source).not.toHaveProperty('auth_json');

    const run = await request(app.getHttpServer())
      .post(`/api/v1/system/metadata-sync/${source.id}/run`)
      .set(TOKEN_HEADER, token);
    expect(run.status).toBe(200);
    expect((run.body as ApiEnvelope<RunResult>).data).toMatchObject({
      status: 'success',
      applied: 1,
      failed_count: 0,
    });

    const saved = await prisma.tableSemantic.findFirst({
      where: { datasourceId: 1, tableName: 'sync_order' },
    });
    expect(saved?.meaning).toBe('外部同步的订单表');

    const runs = await request(app.getHttpServer())
      .get(`/api/v1/system/metadata-sync/${source.id}/runs/1/20`)
      .set(TOKEN_HEADER, token);
    expect(runs.status).toBe(200);
    const page = (
      runs.body as ApiEnvelope<{
        data: Array<{ status: string; applied: number }>;
        total_count: number;
      }>
    ).data;
    expect(page.total_count).toBeGreaterThanOrEqual(1);
    expect(page.data[0]).toMatchObject({ status: 'success', applied: 1 });
  });

  it('encrypts auth, masks it and forwards it as request headers', async () => {
    rows = [];
    const created = await createSource({
      name: `e2e-sync-${suffix}-b`,
      kind: 'HTTP_API',
      target: 'semantic',
      endpoint,
      http_method: 'GET',
      auth: { token: 'sync-token', headers: { 'X-API-Key': 'sync-key' } },
    });
    expect(created.status).toBe(200);
    const source = (created.body as ApiEnvelope<SourceSnake>).data;
    expect(source.has_auth).toBe(true);
    expect(source).not.toHaveProperty('auth_json');

    const stored = await prisma.metadataSyncSource.findUnique({
      where: { id: source.id },
    });
    expect(stored!.authJson).not.toContain('sync-key');

    const run = await request(app.getHttpServer())
      .post(`/api/v1/system/metadata-sync/${source.id}/run`)
      .set(TOKEN_HEADER, token);
    expect(run.status).toBe(200);
    expect(lastHeaders.authorization).toBe('Bearer sync-token');
    expect(lastHeaders['x-api-key']).toBe('sync-key');
  });

  it('rejects invalid endpoints and invalid crons', async () => {
    const badEndpoint = await createSource({
      name: `e2e-sync-${suffix}-bad-endpoint`,
      kind: 'HTTP_API',
      target: 'semantic',
      endpoint: 'ftp://example.com/rows',
    });
    expect(badEndpoint.status).toBe(400);

    const badCron = await createSource({
      name: `e2e-sync-${suffix}-bad-cron`,
      kind: 'HTTP_API',
      target: 'semantic',
      endpoint,
      cron: 'not-a-cron',
    });
    expect(badCron.status).toBe(400);
  });

  it('deletes a source and cascades its run history', async () => {
    const created = await createSource({
      name: `e2e-sync-${suffix}-c`,
      kind: 'HTTP_API',
      target: 'semantic',
      endpoint,
    });
    const source = (created.body as ApiEnvelope<SourceSnake>).data;
    await prisma.metadataSyncRun.create({
      data: { sourceId: source.id, trigger: 'manual', status: 'success' },
    });
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/system/metadata-sync/${source.id}`)
      .set(TOKEN_HEADER, token);
    expect(del.status).toBe(200);
    expect(
      await prisma.metadataSyncRun.count({ where: { sourceId: source.id } }),
    ).toBe(0);
  });
});
