// Query result cache e2e (MetaDataImprove M7) — the execSql funnel serves a
// repeated identical SQL from Postgres (cache.enabled parameter), and a
// semantic-revision bump invalidates it. Uses a real temp SQLite datasource
// (same fixture pattern as datasource.e2e-spec) and the REAL
// DatasourceService; the cache is switched on via a saved parameter row.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { encryptFrontendConfig } from './../src/datasource/frontend-config-crypto';
import { waitFor } from './helpers/wait-for';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

const stamp = Date.now();
const tempDbPath = `/tmp/test-cache-e2e-${stamp}.db`;

describe('SQL result cache (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let dsId: number;
  const SQL = 'SELECT id, total FROM orders ORDER BY id';

  beforeAll(async () => {
    const db = new Database(tempDbPath);
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)');
    db.exec('INSERT INTO orders (id, total) VALUES (1, 9.99)');
    db.exec('INSERT INTO orders (id, total) VALUES (2, 5.01)');
    db.close();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = (
      await request(app.getHttpServer())
        .post('/api/v1/login/access-token')
        .send({ username: 'admin', password: 'admin' })
    ).body.data.access_token as string;

    // cache.enabled = true (saved parameter beats the OFF default)
    await prisma.systemVariable.upsert({
      where: { name: 'cache.enabled' },
      create: {
        name: 'cache.enabled',
        varType: 'str',
        type: 'parameter',
        value: true,
      },
      update: { value: true },
    });
    // Fresh slate regardless of suite order: earlier datasource suites may
    // already have bumped the revision (add/sync/remove all invalidate).
    await prisma.systemVariable.deleteMany({ where: { type: 'cache_rev' } });
    await prisma.queryCacheEntry.deleteMany({ where: {} });

    const add = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, token)
      .send({
        name: `cache-e2e-${stamp}`,
        type: 'sqlite',
        configuration: encryptFrontendConfig({ db: tempDbPath }),
      });
    expect(add.status).toBe(200);
    dsId = (add.body as ApiEnvelope<{ id: number }>).data.id;
  });

  afterAll(async () => {
    await prisma.queryCacheEntry
      .deleteMany({ where: {} })
      .catch(() => undefined);
    await prisma.systemVariable
      .deleteMany({ where: { type: 'parameter', name: 'cache.enabled' } })
      .catch(() => undefined);
    await prisma.systemVariable
      .deleteMany({ where: { type: 'cache_rev' } })
      .catch(() => undefined);
    if (dsId) {
      await prisma.datasource
        .deleteMany({ where: { id: dsId } })
        .catch(() => undefined);
    }
    await app.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  async function exec(): Promise<{ columns: string[]; rows: unknown[][] }> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/datasource/execSql/${dsId}`)
      .set(TOKEN_HEADER, token)
      .send({ sql: SQL });
    expect(res.status).toBe(200);
    return (res.body as ApiEnvelope<{ columns: string[]; rows: unknown[][] }>)
      .data;
  }

  // Each test starts from the same 2-row table + empty cache so it can run in
// any order (jest --randomize).
  beforeEach(() => {
    const db = new Database(tempDbPath);
    db.exec('DELETE FROM orders');
    db.exec('INSERT INTO orders (id, total) VALUES (1, 9.99)');
    db.exec('INSERT INTO orders (id, total) VALUES (2, 5.01)');
    db.close();
    return prisma.queryCacheEntry.deleteMany({ where: {} });
  });

  it('caches a repeated identical SQL and serves the hit', async () => {
    const first = await exec();
    expect(first.rows).toHaveLength(2);

    // The store is fire-and-forget — poll for the entry.
    const entries = await waitFor(
      () => prisma.queryCacheEntry.findMany(),
      (rows) => rows.length === 1,
    );
    expect(entries[0].rowCount).toBe(2);
    // The cached SQL is the EFFECTIVE sql (LIMIT appended, not raw).
    expect(entries[0].sql).toContain('LIMIT');
    const rev = await prisma.systemVariable.findUnique({
      where: { name: 'cache.rev.1' },
    });
    const expectedRevision =
      rev && typeof rev.value === 'number' ? rev.value : 0;
    expect(entries[0].revision).toBe(expectedRevision);

    // Change the data under the SAME SQL: a hit within TTL serves the stale
    // snapshot by design — the revision bump below is the invalidation path.
    const db = new Database(tempDbPath);
    db.exec('INSERT INTO orders (id, total) VALUES (3, 1.5)');
    db.close();
    const second = await exec();
    expect(second.rows).toHaveLength(2); // cache hit, not 3
    expect(await prisma.queryCacheEntry.count()).toBe(1);
  });

  it('a semantic-revision bump invalidates the entry', async () => {
    // Make the data change idempotent: this test must pass even if it runs
    // before the cache test (which also inserts row 3).
    const db = new Database(tempDbPath);
    db.exec('INSERT OR IGNORE INTO orders (id, total) VALUES (3, 1.5)');
    db.close();
    // Bump FORWARD from whatever the current revision is (a lower write
    // would resurrect stale entries — never do that, here or in prod).
    const row = await prisma.systemVariable.findUnique({
      where: { name: 'cache.rev.1' },
    });
    const current = row && typeof row.value === 'number' ? row.value : 0;
    await prisma.systemVariable.upsert({
      where: { name: 'cache.rev.1' },
      create: {
        name: 'cache.rev.1',
        varType: 'number',
        type: 'cache_rev',
        value: current + 1,
      },
      update: { value: current + 1 },
    });
    const fresh = await exec();
    expect(fresh.rows).toHaveLength(3); // re-executed against new data
    const entries = await waitFor(
      () => prisma.queryCacheEntry.findMany(),
      (rows) => rows.length === 1 && rows[0].revision === current + 1,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ revision: current + 1, rowCount: 3 });
  });
});
