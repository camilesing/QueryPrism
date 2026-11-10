// Semantic ingestion e2e — MetaDataImprove M2 channels: the ApiKeyGuard-
// authenticated POST /meta/semantic/import (JSON batch) and the admin Excel
// export/import round-trip. Real services + real Prisma.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
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

describe('Semantic ingestion (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let apiKeyId: number | null = null;
  let accessKey = '';
  let secret = '';
  let memberAccount = '';
  let memberToken = '';
  let memberUid = 0;

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

    // Provision one API key for the admin (uid 1) — created + revealed via
    // the existing apikey admin surface.
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(created.status).toBe(200);
    apiKeyId = (created.body as ApiEnvelope<{ id: number }>).data.id;
    const list = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const keyRow = (
      list.body as ApiEnvelope<Array<{ id: number; access_key: string }>>
    ).data.find((k) => k.id === apiKeyId);
    accessKey = keyRow!.access_key;
    const revealed = await request(app.getHttpServer())
      .get(`/api/v1/system/apikey/${apiKeyId}/secret`)
      .set(TOKEN_HEADER, token);
    secret = (revealed.body as ApiEnvelope<{ secret_key: string }>).data
      .secret_key;

    // A normal member of workspace 1 for the per-row scope-authority test.
    memberAccount = `e2e-sem-meta-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Semantic Meta Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    const memberLogin = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: memberAccount, password: 'Init1234!' });
    memberToken = (memberLogin.body as ApiEnvelope<{ access_token: string }>)
      .data.access_token;
    memberUid = (await prisma.user.findUnique({
      where: { account: memberAccount },
    }))!.id;
  });

  afterAll(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    if (apiKeyId != null) {
      await prisma.apiKey
        .delete({ where: { id: apiKeyId } })
        .catch(() => undefined);
    }
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('rejects the meta import without API key headers (401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/semantic/import')
      .send([
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 'x',
          meaning: 'y',
        },
      ]);
    expect(res.status).toBe(401);
  });

  it('imports a JSON batch at the WORKSPACE layer via API key auth', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/semantic/import')
      .set('X-QUERYPRISM-APIKEY', accessKey)
      .set('X-QUERYPRISM-APISECRET', secret)
      .send([
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 'api_order',
          meaning: '接口导入的订单表',
        },
        // A bad row is reported, not fatal.
        {
          entity_type: 'table',
          datasource_id: -9,
          table_name: 'bad',
          meaning: 'x',
        },
      ]);
    expect(res.status).toBe(200);
    const out = (
      res.body as ApiEnvelope<{ applied: number; failed: unknown[] }>
    ).data;
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(1);

    const row = await prisma.tableSemantic.findFirst({
      where: { scope: 'WORKSPACE', tableName: 'api_order' },
    });
    expect(row?.meaning).toBe('接口导入的订单表');
  });

  it('imports PERSONAL/GLOBAL rows and reports invalid scopes per row', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/semantic/import')
      .set('X-QUERYPRISM-APIKEY', accessKey)
      .set('X-QUERYPRISM-APISECRET', secret)
      .send([
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 'api_personal',
          meaning: '个人语义',
          scope: 'PERSONAL',
          enabled: false,
        },
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 'api_global',
          meaning: '全局语义',
          scope: 'GLOBAL',
        },
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 'api_bad_scope',
          meaning: 'bad',
          scope: 'team',
        },
      ]);
    expect(res.status).toBe(200);
    const out = (
      res.body as ApiEnvelope<{
        applied: number;
        by_scope: Record<string, number>;
        failed: unknown[];
      }>
    ).data;
    expect(out.applied).toBe(2);
    expect(out.by_scope).toEqual({ GLOBAL: 1, WORKSPACE: 0, PERSONAL: 1 });
    expect(out.failed).toHaveLength(1);

    const personal = await prisma.tableSemantic.findFirst({
      where: { scope: 'PERSONAL', tableName: 'api_personal' },
    });
    expect(personal?.ownerUid).toBe(1);
    expect(personal?.enabled).toBe(false);
    const global = await prisma.tableSemantic.findFirst({
      where: { scope: 'GLOBAL', tableName: 'api_global' },
    });
    expect(global?.oid).toBeNull();
    expect(global?.meaning).toBe('全局语义');
  });

  it('lets a member import PERSONAL rows while WORKSPACE/GLOBAL rows fail', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('table_semantics');
    ws.addRow(['datasource_id', 'table_name', 'meaning', 'enabled', 'scope']);
    ws.addRow([1, 'member_personal', '成员个人语义', 'true', 'PERSONAL']);
    ws.addRow([1, 'member_workspace', '成员空间语义', 'true', 'WORKSPACE']);
    ws.addRow([1, 'member_global', '成员全局语义', 'true', 'GLOBAL']);
    const buf = await wb.xlsx.writeBuffer();

    const uploaded = await request(app.getHttpServer())
      .post('/api/v1/system/semantic/uploadExcel')
      .set(TOKEN_HEADER, memberToken)
      .attach('file', Buffer.from(buf), 'semantics-member.xlsx');
    expect(uploaded.status).toBe(200);
    const out = (
      uploaded.body as ApiEnvelope<{
        applied: number;
        by_scope: Record<string, number>;
        failed: unknown[];
      }>
    ).data;
    expect(out.applied).toBe(1);
    expect(out.by_scope).toEqual({ GLOBAL: 0, WORKSPACE: 0, PERSONAL: 1 });
    expect(out.failed).toHaveLength(2);

    const personal = await prisma.tableSemantic.findFirst({
      where: { scope: 'PERSONAL', tableName: 'member_personal' },
    });
    expect(personal?.ownerUid).toBe(memberUid);
    expect(
      await prisma.tableSemantic.findFirst({
        where: { tableName: 'member_workspace' },
      }),
    ).toBeNull();
    expect(
      await prisma.tableSemantic.findFirst({
        where: { tableName: 'member_global' },
      }),
    ).toBeNull();
  });

  it('Excel export → import round-trips rows', async () => {
    const exported = await request(app.getHttpServer())
      .get('/api/v1/system/semantic/export')
      .set(TOKEN_HEADER, token)
      .responseType('blob');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('spreadsheetml');
    const exportedWb = new ExcelJS.Workbook();
    const exportedBytes: unknown = exported.body;
    await exportedWb.xlsx.load(exportedBytes as ExcelJS.Buffer);
    expect(
      exportedWb.getWorksheet('table_semantics')!.getRow(1).values,
    ).toContain('scope');
    expect(
      exportedWb.getWorksheet('field_semantics')!.getRow(1).values,
    ).toContain('scope');

    // Build a tiny import workbook (table sheet) and upload it.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('table_semantics');
    ws.addRow(['datasource_id', 'table_name', 'meaning', 'enabled', 'scope']);
    ws.addRow([1, 'excel_order', 'Excel 导入的订单表', 'false', 'PERSONAL']);
    const buf = await wb.xlsx.writeBuffer();

    const uploaded = await request(app.getHttpServer())
      .post('/api/v1/system/semantic/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', Buffer.from(buf), 'semantics.xlsx');
    expect(uploaded.status).toBe(200);
    const out = (uploaded.body as ApiEnvelope<{ applied: number }>).data;
    expect(out.applied).toBeGreaterThanOrEqual(1);

    const row = await prisma.tableSemantic.findFirst({
      where: { scope: 'PERSONAL', tableName: 'excel_order' },
    });
    expect(row?.meaning).toBe('Excel 导入的订单表');
    expect(row?.ownerUid).toBe(1);
    expect(row?.enabled).toBe(false);
  });
});
