import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { DatasourceService } from './datasource.service';
import { PrismaService } from '../database/prisma.service';
import { DbConnectorFactory } from './db-connector/db-connector.factory';
import { ExcelStoreService } from './excel-store.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorService } from '../vector/vector.service';
import { QueryCacheService } from '../quota/query-cache.service';
import { encryptFrontendConfig } from './frontend-config-crypto';
import { appendLimit } from './db-connector/limit-clause';
import { effectiveSqlHash } from '../quota/quota-policy';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const AES_KEY = 'test-aes-key';

/** Every datasource entry point resolves the current workspace from ALS.
 *  Wrap the service so each method call runs inside a request context; Jest
 *  does not preserve an `enterWith` store across its beforeEach/test boundary. */
function withRequestContext<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]): unknown =>
        requestContextStorage.run(
          {
            user: { id: 1, account: 'admin', oid: 1, language: 'zh-CN' },
          },
          () => fn.apply(t, args),
        );
    },
  });
}

// A minimal Datasource row with the new (Phase 2) shape. Cast as never to
// satisfy mockResolvedValue without hand-typing every Prisma JSON field.
function mockDatasourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 't',
    description: null,
    type: 'sqlite',
    configuration: null,
    status: 'active',
    tableRelation: null,
    embedding: null,
    recommendedConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

// Embedding/vector mocks with settable `available` so the recallTables tests
// can flip them on; the default (false) keeps the fire-and-forget embed hooks
// in create/update/syncTables as no-ops.
const embeddingMock = {
  available: false,
  embed: jest.fn(),
  embedBatch: jest.fn(),
};
const vectorMock = {
  available: false,
  search: jest.fn(),
  upsert: jest.fn(),
  remove: jest.fn(),
  clear: jest.fn(),
};
const excelStoreMock = { dropTables: jest.fn(), receive: jest.fn() };

describe('DatasourceService', () => {
  beforeEach(() => setI18n(createTestI18n()));
  let service: DatasourceService;
  let prismaService: PrismaService;
  let factory: DbConnectorFactory;
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatasourceService,
        PrismaService,
        DbConnectorFactory,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'aes.key') return AES_KEY;
              if (key === 'chat.limitRows') return 1000;
              return undefined;
            },
          },
        },
        // Embedding/vector disabled in the datasource suite — the fire-and-
        // forget embed hooks must no-op (early-return on available:false)
        // so they don't touch the real prisma or pgvector.
        { provide: EmbeddingService, useValue: embeddingMock },
        { provide: VectorService, useValue: vectorMock },
        {
          provide: ExcelStoreService,
          useValue: excelStoreMock,
        },
        // M7: the execSql funnel's query cache — off by default; the lookup
        // stub returns a miss so every exec goes through the connector.
        {
          provide: QueryCacheService,
          useValue: {
            currentRevision: jest.fn().mockResolvedValue(0),
            bumpRevision: jest.fn().mockResolvedValue(undefined),
            lookup: jest.fn().mockResolvedValue(null),
            store: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    // The suite mocks every Prisma delegate call; only connect/disconnect need
    // stubbing so the unit suite does not require a live PostgreSQL instance.
    prismaService = module.get(PrismaService);
    const lifecycle = prismaService as unknown as {
      $connect: jest.Mock;
      $disconnect: jest.Mock;
    };
    lifecycle.$connect = jest.fn().mockResolvedValue(undefined);
    lifecycle.$disconnect = jest.fn().mockResolvedValue(undefined);

    app = module.createNestApplication();
    await app.init();

    service = withRequestContext(module.get(DatasourceService));
    prismaService = module.get(PrismaService);
    factory = module.get(DbConnectorFactory);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Reset the embedding/vector flag-flipping done in recallTables tests so
    // the default no-op behavior holds for the rest of the suite.
    embeddingMock.available = false;
    vectorMock.available = false;
    embeddingMock.embed.mockReset();
    vectorMock.search.mockReset();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // MetaDataImprove M3: every relation save is versioned in one transaction.
  describe('saveTableRelation versioning', () => {
    function mockTx(owned: boolean) {
      const tx = {
        datasource: {
          findFirst: jest.fn().mockResolvedValue(owned ? { id: 1 } : null),
          update: jest.fn().mockResolvedValue({ relationVersion: 3 }),
        },
        datasourceRelationVersion: {
          create: jest.fn().mockResolvedValue({ id: 9 }),
        },
      };
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (client: unknown) => Promise<unknown>)(tx)
            : Promise.all(arg as Promise<unknown>[]),
        );
      return tx;
    }

    it('increments the version and appends a snapshot', async () => {
      const tx = mockTx(true);
      const edges = [{ id: 'e1', shape: 'edge' }];

      await expect(service.saveTableRelation(1, edges)).resolves.toEqual({
        success: true,
        edges,
        version: 3,
      });
      expect(tx.datasource.findFirst).toHaveBeenCalledWith({
        where: { id: 1, oid: 1 },
        select: { id: true },
      });
      expect(tx.datasource.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          tableRelation: edges,
          relationVersion: { increment: 1 },
        },
        select: { relationVersion: true },
      });
      expect(tx.datasourceRelationVersion.create).toHaveBeenCalledWith({
        data: {
          datasourceId: 1,
          version: 3,
          snapshot: edges,
          changedBy: 1,
        },
      });
    });

    it('rejects a datasource outside the current workspace', async () => {
      mockTx(false);
      await expect(service.saveTableRelation(2, [])).rejects.toThrow(
        '数据源 #2 不存在',
      );
    });
  });

  // MetaDataImprove M3 follow-up: restore appends a new version, compare
  // diffs the normalized FK edges of two saved snapshots.
  describe('relation version restore / compare', () => {
    const edgeA = {
      fromTable: 'orders',
      fromField: 'user_id',
      toTable: 'users',
      toField: 'id',
    };
    const edgeB = {
      fromTable: 'orders',
      fromField: 'product_id',
      toTable: 'products',
      toField: 'id',
    };

    function mockRestoreTx(snapshot: unknown) {
      const tx = {
        datasource: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
          update: jest.fn().mockResolvedValue({ relationVersion: 4 }),
        },
        datasourceRelationVersion: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              snapshot === null ? null : { id: 7, version: 2, snapshot },
            ),
          create: jest.fn().mockResolvedValue({ id: 10 }),
        },
      };
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (client: unknown) => Promise<unknown>)(tx)
            : Promise.all(arg as Promise<unknown>[]),
        );
      return tx;
    }

    it('restores a snapshot as a new version and keeps changedBy/note', async () => {
      const tx = mockRestoreTx([edgeA]);

      await expect(service.restoreTableRelation(1, 2)).resolves.toEqual({
        success: true,
        version: 4,
        restoredFrom: 2,
      });
      expect(tx.datasource.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          tableRelation: [edgeA],
          relationVersion: { increment: 1 },
        },
        select: { relationVersion: true },
      });
      expect(tx.datasourceRelationVersion.create).toHaveBeenCalledWith({
        data: {
          datasourceId: 1,
          version: 4,
          snapshot: [edgeA],
          changedBy: 1,
          note: '从版本 2 恢复',
        },
      });
    });

    it('404s an unknown snapshot version', async () => {
      mockRestoreTx(null);
      await expect(service.restoreTableRelation(1, 9)).rejects.toThrow(
        '数据源 #1 不存在关系版本 9',
      );
    });

    it('compares a saved version against the newest snapshot by default', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue({ id: 1 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findFirst')
        .mockResolvedValue({ version: 3 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findMany')
        .mockResolvedValue([
          { version: 3, snapshot: [edgeA, edgeB] },
          { version: 2, snapshot: [edgeA] },
        ] as never);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([] as never);

      await expect(service.compareTableRelation(1, 2)).resolves.toEqual({
        fromVersion: 2,
        toVersion: 3,
        added: [edgeB],
        removed: [],
      });
      expect(prismaService.table.findMany).toHaveBeenCalledWith({
        where: { datasourceId: 1 },
        select: {
          id: true,
          tableName: true,
          fields: { select: { id: true, fieldName: true } },
        },
      });
    });

    it('compares two explicit versions in either direction', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue({ id: 1 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findFirst')
        .mockResolvedValue({ version: 2 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findMany')
        .mockResolvedValue([
          { version: 2, snapshot: [edgeA, edgeB] },
          { version: 1, snapshot: [edgeA] },
        ] as never);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([] as never);

      await expect(service.compareTableRelation(1, 2, 1)).resolves.toEqual({
        fromVersion: 2,
        toVersion: 1,
        added: [],
        removed: [edgeB],
      });
    });

    it('404s an unknown from-version', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue({ id: 1 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findFirst')
        .mockResolvedValue({ version: 1 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findMany')
        .mockResolvedValue([{ version: 1, snapshot: [] }] as never);

      await expect(service.compareTableRelation(1, 7)).rejects.toThrow(
        '数据源 #1 不存在关系版本 7',
      );
    });
  });

  describe('testConnection (integration via real better-sqlite3)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;

    beforeEach(() => {
      testDbPath = `/tmp/test-ds-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      );
      db.close();

      // testConnection persists datasource.status — keep the real DB untouched.
      jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue({} as never);
    });

    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('connects to a real SQLite file and reports its version', async () => {
      const configuration = factory.encryptConfiguration({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration }));

      const result = await service.testConnection(1);

      expect(result.success).toBe(true);
      expect(result.version).toContain('SQLite');
    });

    it('reports a failure (never throws) for an unopenable path', async () => {
      const configuration = factory.encryptConfiguration({
        db: '/nonexistent-dir-does-not-exist/x.db',
      });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration }));

      // Tolerant to either a returned failure or a thrown error — the product
      // contract is "the user gets a failure result, not a 500".
      const result = await service.testConnection(1).catch((e: unknown) => ({
        success: false,
        message: e instanceof Error ? e.message : String(e),
      }));

      expect(result.success).toBe(false);
    });
  });

  describe('syncTables (integration via real better-sqlite3)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('syncs tables and fields from a real SQLite file', async () => {
      const testDbPath = `/tmp/test-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
        CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, user_id INTEGER);
      `);
      db.close();

      const configuration = factory.encryptConfiguration({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(
          mockDatasourceRow({ name: 'Test DB', configuration }),
        );

      const tableRow = {
        id: 100,
        datasourceId: 1,
        tableName: '',
        tableComment: null,
      } as never;
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prismaService.table, 'create').mockResolvedValue(tableRow);
      jest.spyOn(prismaService.table, 'update').mockResolvedValue(tableRow);
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([]);
      jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest
        .spyOn(prismaService.field, 'update')
        .mockResolvedValue({ id: 1 } as never);

      const result = await service.syncTables(1);

      expect(result.success).toBe(true);
      expect(result.tableCount).toBe(2);

      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    });
  });

  describe('getMSchema', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('builds a compact M-Schema honoring checked, comments, and FKs', async () => {
      const now = new Date();
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          name: 'shop',
          tableRelation: [
            {
              fromTable: 'orders',
              fromField: 'user_id',
              toTable: 'users',
              toField: 'id',
            },
          ],
          tables: [
            {
              id: 1,
              datasourceId: 1,
              tableName: 'users',
              tableComment: null,
              customComment: '用户表',
              checked: true,
              embedding: null,
              createdAt: now,
              updatedAt: now,
              fields: [
                {
                  id: 1,
                  tableId: 1,
                  fieldName: 'id',
                  fieldType: 'INTEGER',
                  fieldComment: null,
                  customComment: null,
                  isPrimaryKey: true,
                  fieldIndex: 0,
                  checked: true,
                  createdAt: now,
                  updatedAt: now,
                },
                {
                  id: 2,
                  tableId: 1,
                  fieldName: 'name',
                  fieldType: 'TEXT',
                  fieldComment: 'display name',
                  customComment: null,
                  isPrimaryKey: false,
                  fieldIndex: 1,
                  checked: true,
                  createdAt: now,
                  updatedAt: now,
                },
                {
                  id: 3,
                  tableId: 1,
                  fieldName: 'secret',
                  fieldType: 'TEXT',
                  fieldComment: null,
                  customComment: null,
                  isPrimaryKey: false,
                  fieldIndex: 2,
                  checked: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
            {
              id: 2,
              datasourceId: 1,
              tableName: 'orders',
              tableComment: null,
              customComment: null,
              checked: true,
              embedding: null,
              createdAt: now,
              updatedAt: now,
              fields: [
                {
                  id: 4,
                  tableId: 2,
                  fieldName: 'user_id',
                  fieldType: 'INTEGER',
                  fieldComment: null,
                  customComment: null,
                  isPrimaryKey: false,
                  fieldIndex: 0,
                  checked: true,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
          ],
        }),
      );

      const schema = await service.getMSchema(1);

      expect(schema).toContain('# Table: users # 用户表');
      expect(schema).toContain('id INTEGER (PK)');
      expect(schema).toContain('name TEXT # display name');
      // A checked:false field must never reach the LLM.
      expect(schema).not.toContain('secret');
      expect(schema).toContain('【Foreign keys】');
      expect(schema).toContain('orders(user_id) -> users(id)');
    });

    it('narrows to the given tableIds when provided (checked still applies)', async () => {
      const now = new Date();
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          name: 'shop',
          tableRelation: null,
          tables: [
            {
              id: 1,
              datasourceId: 1,
              tableName: 'users',
              tableComment: null,
              customComment: null,
              checked: true,
              embedding: null,
              createdAt: now,
              updatedAt: now,
              fields: [],
            },
            {
              id: 2,
              datasourceId: 1,
              tableName: 'orders',
              tableComment: null,
              customComment: null,
              checked: true,
              embedding: null,
              createdAt: now,
              updatedAt: now,
              fields: [],
            },
          ],
        }),
      );

      // Only the users table (id=1) is requested — orders must be omitted.
      const schema = await service.getMSchema(1, [1]);
      expect(schema).toContain('# Table: users');
      expect(schema).not.toContain('# Table: orders');
    });
  });

  describe('recallTables (keyword-fused ranking)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    // recallTables verifies datasource ownership before touching table rows.
    beforeEach(() => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
    });
    const now = new Date();
    const mkTable = (id: number, tableName: string, extra: object = {}) =>
      ({
        id,
        datasourceId: 1,
        tableName,
        tableComment: null,
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: now,
        updatedAt: now,
        fields: [],
        ...extra,
      }) as never;
    const table5 = mkTable(5, 'users');
    const table6 = mkTable(6, 'orders');
    // explicit snapshot so the tests never read the real SystemVariable table
    const cfg = {
      enabled: true,
      dataTrainingSimilarity: 0.4,
      dataTrainingTopCount: 5,
      tableEnabled: true,
      tableCount: 10,
      tableAlpha: 0.4,
      keywordEnabled: true,
      datasourceCount: 10,
    };

    beforeEach(() => {
      embeddingMock.available = true;
      vectorMock.available = true;
      embeddingMock.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    });

    it('pure-vector pass keeps cosine order (no keywords)', async () => {
      vectorMock.search.mockReturnValue([
        { id: 5, distance: 0.1 },
        { id: 6, distance: 0.5 },
        { id: 5, distance: 0.9 }, // dedup is the DB map's job — same id twice
      ]);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, table6]);

      const result = await service.recallTables(1, '用户订单', { config: cfg });
      expect(result.map((t) => t.id)).toEqual([5, 6]);
    });

    it('caps the result at topK', async () => {
      vectorMock.search.mockReturnValue([
        { id: 5, distance: 0.1 },
        { id: 6, distance: 0.5 },
      ]);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, table6]);

      const result = await service.recallTables(1, 'q', {
        config: cfg,
        topK: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(5);
    });

    it('an explicitly named table outranks higher-vector distractors', async () => {
      const salesOrder = mkTable(7, 'sales_order');
      vectorMock.search.mockReturnValue([
        { id: 5, distance: 0.05 },
        { id: 6, distance: 0.1 },
        { id: 7, distance: 1.5 },
      ]);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, table6, salesOrder]);

      // keyword hit + question mention both target sales_order
      const result = await service.recallTables(1, '查 sales_order 表的订单', {
        keywords: 'sales_order',
        config: cfg,
      });
      expect(result[0].tableName).toBe('sales_order');
    });

    it('an explicit mention survives even without keywords (vector-only)', async () => {
      const salesOrder = mkTable(7, 'sales_order');
      vectorMock.search.mockReturnValue([
        { id: 5, distance: 0.05 },
        { id: 7, distance: 1.5 },
      ]);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, salesOrder]);

      const result = await service.recallTables(1, '查 sales_order', {
        config: cfg,
        topK: 1,
      });
      expect(result.map((t) => t.tableName)).toEqual(['sales_order']);
    });

    it('keywordEnabled=false → pure vector ranking (explicit mention still applies)', async () => {
      vectorMock.search.mockReturnValue([
        { id: 5, distance: 0.1 },
        { id: 6, distance: 0.2 },
      ]);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, table6]);

      // keyword scores are ignored, but the question names `orders` (id 6) —
      // upstream test_keyword_disabled: retention survives the keyword switch
      const result = await service.recallTables(1, '查 orders', {
        keywords: 'orders',
        config: { ...cfg, keywordEnabled: false },
      });
      expect(result.map((t) => t.id)).toEqual([6, 5]);
    });

    it('a vector failure zeroes vector scores but keeps every candidate', async () => {
      embeddingMock.embed.mockRejectedValue(new Error('upstream down'));
      const salesOrder = mkTable(7, 'sales_order');
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([table5, table6, salesOrder]);

      // keyword ranking still orders; nothing is dropped
      const result = await service.recallTables(1, '统计销售额', {
        keywords: 'sales_order,销售额',
        config: cfg,
      });
      expect(result).toHaveLength(3);
      expect(result[0].tableName).toBe('sales_order');
    });

    it('returns [] when tableEnabled is off (pre-filter layer skipped)', async () => {
      const result = await service.recallTables(1, 'q', {
        config: { ...cfg, tableEnabled: false },
      });
      expect(result).toEqual([]);
      expect(vectorMock.search).not.toHaveBeenCalled();
    });

    it('returns [] when embedding or vector is unavailable', async () => {
      embeddingMock.available = false;
      expect(await service.recallTables(1, 'q', { config: cfg })).toEqual([]);
      embeddingMock.available = true;
      vectorMock.available = false;
      expect(await service.recallTables(1, 'q', { config: cfg })).toEqual([]);
      expect(vectorMock.search).not.toHaveBeenCalled();
    });

    it('returns [] for an empty question', async () => {
      const result = await service.recallTables(1, '   ', { config: cfg });
      expect(result).toEqual([]);
      expect(embeddingMock.embed).not.toHaveBeenCalled();
    });
  });

  // ─── Phase 10 §95: configuration stored verbatim (frontend pre-encrypts) ──
  describe('create / update — configuration storage', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('create stores a STRING configuration as-is (frontend pre-encrypts)', async () => {
      const conf = encryptFrontendConfig({ db: '/tmp/any.db' });
      const createSpy = jest
        .spyOn(prismaService.datasource, 'create')
        .mockResolvedValue(mockDatasourceRow({ id: 5, configuration: conf }));
      await service.create({
        name: 'x',
        description: null,
        type: 'sqlite',
        configuration: conf,
      });
      expect(createSpy.mock.calls[0][0].data.configuration).toBe(conf);
    });

    it('create still encrypts a legacy OBJECT configuration (bridge for old controller)', async () => {
      jest
        .spyOn(prismaService.datasource, 'create')
        .mockResolvedValue(mockDatasourceRow({ id: 6 }));
      const createSpy = jest.spyOn(prismaService.datasource, 'create');
      await service.create({
        name: 'y',
        type: 'sqlite',
        configuration: { db: '/tmp/legacy.db' },
      });
      const stored = createSpy.mock.calls[0][0].data.configuration;
      expect(typeof stored).toBe('string');
      expect(stored).not.toBe('/tmp/legacy.db');
    });

    it('update stores a STRING configuration as-is when provided', async () => {
      const conf = encryptFrontendConfig({ db: '/tmp/new.db' });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      const updateSpy = jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      await service.update(1, { configuration: conf });
      expect(updateSpy.mock.calls[0][0].data.configuration).toBe(conf);
    });
  });

  // ─── §96 action-style route service methods ───────────────────────────
  describe('checkByConf / getTablesByConf / getSchemaByConf', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = `/tmp/test-ds-conf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      db.close();
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('checkByConf returns true for a reachable sqlite config', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      const ok = await service.checkByConf({
        type: 'sqlite',
        configuration: conf,
      });
      expect(ok).toBe(true);
    });

    it('checkByConf returns false for an unopenable path (never throws)', async () => {
      const ok = await service.checkByConf({
        type: 'sqlite',
        configuration: encryptFrontendConfig({
          db: '/nonexistent-dir-does-not-exist/x.db',
        }),
      });
      expect(ok).toBe(false);
    });

    it('checkByConf returns false for an unsupported type', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      const ok = await service.checkByConf({
        type: 'unknown-engine',
        configuration: conf,
      });
      expect(ok).toBe(false);
    });

    it('getTablesByConf returns [{tableName, tableComment}] (camelCase)', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      const tables = await service.getTablesByConf({
        type: 'sqlite',
        configuration: conf,
      });
      expect(Array.isArray(tables)).toBe(true);
      expect(
        (tables as { tableName: string }[]).some(
          (t) => t.tableName === 'users',
        ),
      ).toBe(true);
    });

    it('getSchemaByConf returns [] for sqlite (no schema layer)', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      const schemas = await service.getSchemaByConf({
        type: 'sqlite',
        configuration: conf,
      });
      expect(schemas).toEqual([]);
    });
  });

  describe('checkById / getTables / getFields (stored datasource)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = `/tmp/test-ds-id-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)');
      db.close();
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('checkById returns true for a reachable stored datasource', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue({} as never);
      const ok = await service.checkById(1);
      expect(ok).toBe(true);
    });

    it('checkById returns false for a missing datasource (404 → false)', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(null);
      const ok = await service.checkById(999);
      expect(ok).toBe(false);
    });

    it('getTables returns [{tableName, tableComment}] (camelCase)', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const tables = await service.getTables(1);
      expect(
        (tables as { tableName: string }[]).some(
          (t) => t.tableName === 'orders',
        ),
      ).toBe(true);
    });

    it('getFields returns [{fieldName, fieldType, fieldComment}] (camelCase)', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const fields = await service.getFields(1, 'orders');
      expect(
        (fields as { fieldName: string }[]).some((f) => f.fieldName === 'id'),
      ).toBe(true);
      expect(
        (fields as { fieldName: string }[]).some(
          (f) => f.fieldName === 'total',
        ),
      ).toBe(true);
    });
  });

  describe('tableList / fieldList (persisted rows)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    beforeEach(() => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
    });

    it('tableList returns Table rows ordered by tableName', async () => {
      const now = new Date();
      jest.spyOn(prismaService.table, 'findMany').mockResolvedValue([
        {
          id: 1,
          datasourceId: 5,
          tableName: 'a',
          tableComment: null,
          customComment: null,
          checked: true,
          embedding: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const rows = await service.tableList(5);
      expect(prismaService.table.findMany).toHaveBeenCalledWith({
        where: { datasourceId: 5 },
        orderBy: { tableName: 'asc' },
      });
      expect(rows[0].tableName).toBe('a');
    });

    it('fieldList returns Field rows ordered by fieldIndex (id = TABLE id)', async () => {
      const now = new Date();
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([
        {
          id: 1,
          tableId: 7,
          fieldName: 'id',
          fieldType: 'INTEGER',
          fieldComment: null,
          customComment: null,
          isPrimaryKey: true,
          fieldIndex: 0,
          checked: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const rows = await service.fieldList(7);
      expect(prismaService.field.findMany).toHaveBeenCalledWith({
        where: {
          tableId: 7,
          table: { datasource: { oid: 1 } },
        },
        orderBy: { fieldIndex: 'asc' },
      });
      expect(rows[0].fieldName).toBe('id');
    });

    it('fieldList applies a substring LIKE filter when fieldName is given', async () => {
      const now = new Date();
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([
        {
          id: 1,
          tableId: 7,
          fieldName: 'user_id',
          fieldType: 'INTEGER',
          fieldComment: null,
          customComment: null,
          isPrimaryKey: false,
          fieldIndex: 0,
          checked: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await service.fieldList(7, 'user');
      // SQLite's `contains` compiles to LIKE (ASCII-case-insensitive by
      // default). `mode: 'insensitive'` is unsupported on SQLite — see the
      // service comment + §88.
      expect(prismaService.field.findMany).toHaveBeenCalledWith({
        where: {
          tableId: 7,
          table: { datasource: { oid: 1 } },
          fieldName: { contains: 'user', mode: 'insensitive' },
        },
        orderBy: { fieldIndex: 'asc' },
      });
    });
  });

  describe('editTable / editField (persist ONLY checked + custom_comment by id)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    // Both edits verify the row's owning datasource before updating, inside
    // one interactive transaction (run here on the same spied client).
    let txSpy: jest.SpyInstance;
    beforeEach(() => {
      txSpy = jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation(((fn: (tx: PrismaService) => unknown) =>
          fn(prismaService)) as never);
      jest
        .spyOn(prismaService.table, 'findFirst')
        .mockResolvedValue({ id: 10 } as never);
      jest
        .spyOn(prismaService.field, 'findFirst')
        .mockResolvedValue({ id: 20 } as never);
    });
    afterEach(() => txSpy.mockRestore());

    it('editTable updates checked + custom_comment only (ignores table_name)', async () => {
      const updateSpy = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue({} as never);
      await service.editTable({
        id: 10,
        table_name: 'orders',
        table_comment: '销售',
        custom_comment: '订单',
        checked: false,
      });
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { customComment: '订单', checked: false },
      });
    });

    it('editTable updates only provided fields', async () => {
      const updateSpy = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue({} as never);
      await service.editTable({ id: 10, checked: true });
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { checked: true },
      });
    });

    it('editTable re-embeds with the EFFECTIVE comment (custom wins) — 9e6070e8 invalidation', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockResolvedValue([0.1, 0.2]);
      jest.spyOn(prismaService.table, 'update').mockResolvedValue({
        id: 10,
        tableName: 'orders',
        tableComment: '销售',
        customComment: '订单',
      } as never);
      await service.editTable({ id: 10, custom_comment: '订单' });
      // flush the fire-and-forget embedTable
      await new Promise((r) => setImmediate(r));
      expect(embeddingMock.embed).toHaveBeenCalledWith('orders\n订单');
      // second update persists the embedding column (source of truth)
      expect(prismaService.table.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { embedding: [0.1, 0.2] },
      });
    });

    it('editField updates checked + custom_comment only (ignores field_type)', async () => {
      const updateSpy = jest
        .spyOn(prismaService.field, 'update')
        .mockResolvedValue({} as never);
      await service.editField({
        id: 20,
        field_name: 'uid',
        field_type: 'BIGINT',
        field_comment: 'fk',
        custom_comment: '外键',
        checked: true,
      });
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 20 },
        data: { customComment: '外键', checked: true },
      });
    });

    it('editTable runs the ownership read + update in ONE transaction', async () => {
      jest.spyOn(prismaService.table, 'update').mockResolvedValue({} as never);
      await service.editTable({ id: 10, checked: true });
      expect(txSpy).toHaveBeenCalledTimes(1);
    });

    it('editField runs the ownership read + update in ONE transaction', async () => {
      jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);
      await service.editField({ id: 20, checked: true });
      expect(txSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove (Excel datasource)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    beforeEach(() => excelStoreMock.dropTables.mockReset());
    beforeEach(() => {
      // remove now deletes regression cases + the datasource in one
      // interactive transaction; run the callback against the same mocks.
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(prismaService)) as never);
      jest
        .spyOn(prismaService.regressionCase, 'deleteMany')
        .mockResolvedValue({ count: 0 });
    });

    it('drops the physical sheets AFTER the row delete commits', async () => {
      const order: string[] = [];
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          id: 5,
          type: 'excel',
          configuration: encryptFrontendConfig({
            sheets: [{ tableName: 'sheet_a' }],
          }),
          tables: [{ tableName: 'sheet_a' }],
        }),
      );
      jest.spyOn(prismaService.datasource, 'delete').mockImplementation((() => {
        order.push('delete');
        return Promise.resolve({});
      }) as never);
      excelStoreMock.dropTables.mockImplementation(() => {
        order.push('drop');
        return Promise.resolve();
      });
      await service.remove(5);
      expect(order).toEqual(['delete', 'drop']);
      expect(excelStoreMock.dropTables).toHaveBeenCalledWith(['sheet_a']);
    });

    it('still drops persisted sheet tables when the configuration is unreadable', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          id: 5,
          type: 'excel',
          configuration: 'tampered-ciphertext',
          tables: [{ tableName: 'sheet_a' }, { tableName: 'sheet_b' }],
        }),
      );
      jest
        .spyOn(prismaService.datasource, 'delete')
        .mockResolvedValue({} as never);
      await service.remove(5);
      expect(excelStoreMock.dropTables).toHaveBeenCalledWith([
        'sheet_a',
        'sheet_b',
      ]);
    });

    it('keeps the datasource row when the delete fails (no tables dropped)', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          id: 5,
          type: 'excel',
          configuration: null,
          tables: [{ tableName: 'sheet_a' }],
        }),
      );
      jest
        .spyOn(prismaService.datasource, 'delete')
        .mockRejectedValue(new Error('db down'));
      await expect(service.remove(5)).rejects.toThrow('db down');
      expect(excelStoreMock.dropTables).not.toHaveBeenCalled();
    });
  });

  describe('findByOid (embedded-app workspace picker)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    const rows = () => [
      mockDatasourceRow({ id: 7, configuration: 'cipher-a' }),
      mockDatasourceRow({ id: 8, configuration: 'cipher-b' }),
    ];

    it('hides connection configuration from a plain member of the target workspace', async () => {
      jest
        .spyOn(prismaService.userWs, 'findUnique')
        .mockResolvedValue({ uid: 2, oid: 3, weight: 0 } as never);
      jest
        .spyOn(prismaService.datasource, 'findMany')
        .mockResolvedValue(rows());
      const out = await service.findByOid(3, { id: 2, weight: 1 } as never);
      expect(out.map((r) => r.configuration)).toEqual([null, null]);
    });

    it('returns configuration to an admin of the target workspace', async () => {
      jest
        .spyOn(prismaService.userWs, 'findUnique')
        .mockResolvedValue({ uid: 2, oid: 3, weight: 1 } as never);
      jest
        .spyOn(prismaService.datasource, 'findMany')
        .mockResolvedValue(rows());
      const out = await service.findByOid(3, { id: 2, weight: 0 } as never);
      expect(out.map((r) => r.configuration)).toEqual(['cipher-a', 'cipher-b']);
    });

    it('returns configuration to the system admin', async () => {
      jest
        .spyOn(prismaService.datasource, 'findMany')
        .mockResolvedValue(rows());
      const out = await service.findByOid(3, { id: 1 } as never);
      expect(out.map((r) => r.configuration)).toEqual(['cipher-a', 'cipher-b']);
    });
  });

  describe('syncTable (reconcile incoming selection against persisted rows)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = `/tmp/test-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)',
      );
      db.close();
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('updates tableComment on existing, inserts new, deletes unlisted', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      const existingTable = {
        id: 50,
        datasourceId: 1,
        tableName: 'users',
        tableComment: null,
        customComment: 'old remark',
        checked: true,
      } as never;
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const findFirstSpy = jest
        .spyOn(prismaService.table, 'findFirst')
        .mockImplementation((arg: { where: { tableName: string } }) =>
          Promise.resolve(
            (arg.where.tableName === 'users' ? existingTable : null) as never,
          ),
        );
      const updateSpy = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue(existingTable);
      const createSpy = jest
        .spyOn(prismaService.table, 'create')
        .mockResolvedValue({ id: 60 } as never);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([{ id: 70, tableName: 'stale' } as never]);
      const tableDeleteSpy = jest
        .spyOn(prismaService.table, 'deleteMany')
        .mockResolvedValue({ count: 1 });
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([]);
      const fieldDeleteSpy = jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);

      await service.syncTable(1, [
        { table_name: 'users', table_comment: '用户表' },
        { table_name: 'orders', table_comment: '订单表' },
      ]);

      expect(findFirstSpy).toHaveBeenCalledTimes(2);
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 50 },
        data: { tableComment: '用户表' },
      });
      expect(createSpy).toHaveBeenCalledWith({
        data: {
          datasourceId: 1,
          tableName: 'orders',
          tableComment: '订单表',
          customComment: '订单表',
          checked: true,
        },
      });
      expect(tableDeleteSpy).toHaveBeenCalledWith({
        where: { id: { in: [70] } },
      });
      expect(fieldDeleteSpy).toHaveBeenCalledWith({
        where: { tableId: { in: [70] } },
      });
    });

    it('deletes all tables + fields when incoming list is empty', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const fieldDeleteSpy = jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      const tableDeleteSpy = jest
        .spyOn(prismaService.table, 'deleteMany')
        .mockResolvedValue({ count: 0 });

      await service.syncTable(1, []);

      expect(fieldDeleteSpy).toHaveBeenCalledWith({
        where: { table: { datasourceId: 1 } },
      });
      expect(tableDeleteSpy).toHaveBeenCalledWith({
        where: { datasourceId: 1 },
      });
    });
  });

  describe('chooseTables (check connection then syncTable)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('throws when the datasource connection is unreachable', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          configuration: encryptFrontendConfig({
            db: '/nonexistent-dir-does-not-exist/x.db',
          }),
        }),
      );
      jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue({} as never);
      await expect(
        service.chooseTables(1, [{ table_name: 'users' }]),
      ).rejects.toThrow();
    });

    it('returns {success:true} + syncs when the connection is ok', async () => {
      const testDbPath = `/tmp/test-choose-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
      db.close();
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue({} as never);
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
      jest
        .spyOn(prismaService.table, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest.spyOn(prismaService.table, 'findMany').mockResolvedValue([]);
      jest
        .spyOn(prismaService.table, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([]);
      jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);

      const result = await service.chooseTables(1, [
        { table_name: 'users', table_comment: '用户' },
      ]);
      expect(result).toEqual({ success: true });
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });
  });

  describe('previewData (sample rows projected to checked fields)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = `/tmp/test-prev-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec(
        'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL)',
      );
      db.exec(
        "INSERT INTO products (id, name, price) VALUES (1, 'apple', 1.5)",
      );
      db.close();
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('returns {fields, data, sql} projected to checked fields (body.fields ignored)', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const now = new Date();
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 1,
        tableName: 'products',
        tableComment: null,
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: now,
        updatedAt: now,
      });
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([
        {
          id: 1,
          tableId: 9,
          fieldName: 'id',
          fieldType: 'INTEGER',
          fieldComment: null,
          customComment: null,
          isPrimaryKey: true,
          fieldIndex: 0,
          checked: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 2,
          tableId: 9,
          fieldName: 'name',
          fieldType: 'TEXT',
          fieldComment: null,
          customComment: null,
          isPrimaryKey: false,
          fieldIndex: 1,
          checked: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 3,
          tableId: 9,
          fieldName: 'price',
          fieldType: 'REAL',
          fieldComment: null,
          customComment: null,
          isPrimaryKey: false,
          fieldIndex: 2,
          checked: false,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await service.previewData(1, { table: { id: 9 } });
      expect(result.fields).toEqual(['id', 'name']);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(1);
      expect(result.data[0].name).toBe('apple');
      expect(result.data[0].price).toBeUndefined();
      expect(typeof result.sql).toBe('string');
    });

    it('returns empty {fields:[], data:[], sql:""} when the table has no checked fields', async () => {
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      const now = new Date();
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 1,
        tableName: 'products',
        tableComment: null,
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: now,
        updatedAt: now,
      });
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([]);

      const result = await service.previewData(1, { table: { id: 9 } });
      expect(result).toEqual({ fields: [], data: [], sql: '' });
    });

    it('rejects a table that belongs to another datasource (97d29a4d IDOR)', async () => {
      const now = new Date();
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 2, // path says ds 1 — mismatch
        tableName: 'products',
        tableComment: null,
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        service.previewData(1, { table: { id: 9 } }),
      ).rejects.toThrow('不属于数据源');
    });
  });

  describe('syncFieldsByTableId (re-sync fields for a single table)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it("re-syncs fields from the source DB for the table's datasource", async () => {
      const testDbPath = `/tmp/test-syncf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT)');
      db.close();
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 1,
        tableName: 'items',
        tableComment: null,
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([]);
      jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      const createSpy = jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);

      await service.syncFieldsByTableId(9);
      expect(createSpy).toHaveBeenCalled();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('throws when the table no longer exists in the source DB', async () => {
      const testDbPath = `/tmp/test-syncf2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
      const db = new Database(testDbPath);
      db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY)');
      db.close();
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 1,
        tableName: 'dropped',
        customComment: null,
        checked: true,
        embedding: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      await expect(service.syncFieldsByTableId(9)).rejects.toThrow();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });
  });

  describe('exportDsSchema (xlsx blob)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('returns a non-empty xlsx Buffer for a real datasource', async () => {
      const now = new Date();
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ name: 'shop' }));
      jest.spyOn(prismaService.table, 'findMany').mockResolvedValue([
        {
          id: 1,
          datasourceId: 1,
          tableName: 'users',
          customComment: '用户表',
          checked: true,
          embedding: null,
          createdAt: now,
          updatedAt: now,
        } as never,
      ]);
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([
        {
          id: 1,
          tableId: 1,
          fieldName: 'id',
          customComment: null,
          fieldIndex: 0,
          checked: true,
          createdAt: now,
          updatedAt: now,
        } as never,
      ]);
      const buf = await service.exportDsSchema(1);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
      // xlsx is a zip — starts with the PK magic bytes 0x50 0x4b.
      expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    });

    it('returns a template Buffer for id=0', async () => {
      const buf = await service.exportDsSchema(0);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    });

    it('throws 400 when the datasource has no tables', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ name: 'empty' }));
      jest.spyOn(prismaService.table, 'findMany').mockResolvedValue([]);
      await expect(service.exportDsSchema(1)).rejects.toThrow();
    });
  });

  // ─── appended coverage: lifecycle arms, execSql funnel, degrade paths ────

  /** Fresh throwaway SQLite file with the given DDL executed. */
  function makeSqliteDb(ddl: string): string {
    const path = `/tmp/test-ds-extra-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    const db = new Database(path);
    db.exec(ddl);
    db.close();
    return path;
  }

  /** The M7 query-cache provider mock (shared jest.fn object, never reset). */
  const queryCacheMock = () =>
    app.get<QueryCacheService>(QueryCacheService) as unknown as {
      currentRevision: jest.Mock;
      bumpRevision: jest.Mock;
      lookup: jest.Mock;
      store: jest.Mock;
    };

  /** Stub every Table/Field delegate a sync flow touches. */
  function spySyncDelegates() {
    jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
    jest
      .spyOn(prismaService.table, 'create')
      .mockResolvedValue({ id: 1 } as never);
    jest.spyOn(prismaService.table, 'findMany').mockResolvedValue([] as never);
    jest
      .spyOn(prismaService.table, 'deleteMany')
      .mockResolvedValue({ count: 0 });
    jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([] as never);
    jest
      .spyOn(prismaService.field, 'deleteMany')
      .mockResolvedValue({ count: 0 });
    jest
      .spyOn(prismaService.field, 'create')
      .mockResolvedValue({ id: 1 } as never);
    jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);
    jest
      .spyOn(prismaService.datasource, 'update')
      .mockResolvedValue({} as never);
  }

  describe('create / findAll / findOne / update — row lifecycle + embed hooks', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('findAll returns the workspace datasources', async () => {
      const findMany = jest
        .spyOn(prismaService.datasource, 'findMany')
        .mockResolvedValue([mockDatasourceRow({ id: 3 })]);
      const rows = await service.findAll();
      expect(rows[0].id).toBe(3);
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { oid: 1 } }),
      );
    });

    it('findOne 404s a datasource outside the workspace', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(null);
      await expect(service.findOne(9)).rejects.toThrow('数据源 #9 不存在');
    });

    it('create syncs the incoming table selection immediately', async () => {
      const testDbPath = makeSqliteDb(
        'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      );
      const conf = encryptFrontendConfig({ db: testDbPath });
      jest
        .spyOn(prismaService.datasource, 'create')
        .mockResolvedValue(mockDatasourceRow({ id: 7, configuration: conf }));
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({ configuration: conf }));
      spySyncDelegates();

      await service.create({
        name: 'x',
        type: 'sqlite',
        configuration: conf,
        tables: [{ table_name: 'users', table_comment: '用户' }],
      });

      expect(prismaService.table.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          datasourceId: 7,
          tableName: 'users',
          tableComment: '用户',
          checked: true,
        }),
      });
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('create embeds name+description and upserts the vector', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockResolvedValue([0.3, 0.4]);
      vectorMock.available = true;
      jest
        .spyOn(prismaService.datasource, 'create')
        .mockResolvedValue(
          mockDatasourceRow({ id: 5, name: 'shop', description: '门店' }),
        );
      const dsUpdate = jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue({} as never);

      await service.create({ name: 'shop', type: 'sqlite' });
      // flush the fire-and-forget embedDatasource
      await new Promise((r) => setImmediate(r));

      expect(dsUpdate).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { embedding: [0.3, 0.4] },
      });
      expect(vectorMock.upsert).toHaveBeenCalledWith(
        'datasource',
        5,
        [0.3, 0.4],
      );
    });

    it('create survives an embed failure (fire-and-forget warn only)', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));
      const created = jest
        .spyOn(prismaService.datasource, 'create')
        .mockResolvedValue(mockDatasourceRow({ id: 6, name: 'n' }));

      const row = await service.create({ name: 'n', type: 'sqlite' });
      await new Promise((r) => setImmediate(r));

      expect(row.id).toBe(6);
      expect(created).toHaveBeenCalledTimes(1);
    });

    it('update writes only provided fields; a rebind bumps the cache revision', async () => {
      queryCacheMock().bumpRevision.mockClear();
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      const upd = jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue(mockDatasourceRow({}));

      // name only — no rebind, no cache bump
      await service.update(1, { name: 'n2' });
      expect(upd).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'n2' },
      });
      expect(queryCacheMock().bumpRevision).not.toHaveBeenCalled();

      // type change IS a rebind → revision bump
      await service.update(1, { type: 'mysql' });
      expect(upd).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { type: 'mysql' },
      });
      expect(queryCacheMock().bumpRevision).toHaveBeenCalledTimes(1);

      // status only — neither bump nor embed side effects
      queryCacheMock().bumpRevision.mockClear();
      await service.update(1, { status: 'error' });
      expect(upd).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: 'error' },
      });
      expect(queryCacheMock().bumpRevision).not.toHaveBeenCalled();
    });

    it('update survives an embed failure on a name/description change', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      const upd = jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue(mockDatasourceRow({}));

      await expect(
        service.update(1, { description: 'd' }),
      ).resolves.toBeDefined();
      expect(upd).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { description: 'd' },
      });
      await new Promise((r) => setImmediate(r));
    });

    it('a failed cache-revision bump never fails the cold path', async () => {
      queryCacheMock().bumpRevision.mockRejectedValueOnce(
        new Error('cache down'),
      );
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      jest
        .spyOn(prismaService.datasource, 'update')
        .mockResolvedValue(mockDatasourceRow({}));

      await expect(service.update(1, { type: 'mysql' })).resolves.toBeDefined();
      await new Promise((r) => setImmediate(r)); // flush the warn
    });
  });

  describe('findByOid — guard arms', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('rejects a non-positive / non-integer workspace id', async () => {
      await expect(service.findByOid(0, { id: 2 } as never)).rejects.toThrow(
        '无效的工作空间',
      );
      await expect(service.findByOid(1.5, { id: 2 } as never)).rejects.toThrow(
        '无效的工作空间',
      );
    });

    it('rejects a caller with no membership in the workspace', async () => {
      jest.spyOn(prismaService.userWs, 'findUnique').mockResolvedValue(null);
      await expect(service.findByOid(3, { id: 2 } as never)).rejects.toThrow(
        '无权访问该工作空间',
      );
    });
  });

  describe('connector passthrough (getVersion / previewTable / withConnection)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = makeSqliteDb(
        "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO products (id, name) VALUES (1, 'apple')",
      );
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          configuration: encryptFrontendConfig({ db: testDbPath }),
        }),
      );
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('getVersion reports the engine version', async () => {
      await expect(service.getVersion(1)).resolves.toContain('SQLite');
    });

    it('previewTable returns columns + sampled rows', async () => {
      const out = await service.previewTable(1, 'products', 5);
      expect(out.columns).toEqual(['id', 'name']);
      expect(out.rows).toHaveLength(1);
    });

    it('withConnection runs the callback inside one connector session', async () => {
      const out = await service.withConnection(1, (c) => c.getVersion());
      expect(out).toContain('SQLite');
    });
  });

  describe('execSql (M7 funnel: limit clamp + SQL result cache)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let testDbPath: string;
    beforeEach(() => {
      testDbPath = makeSqliteDb(
        'CREATE TABLE nums (id INTEGER PRIMARY KEY); INSERT INTO nums (id) VALUES (1),(2),(3),(4),(5)',
      );
    });
    afterEach(() => {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    function stubDs() {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          configuration: encryptFrontendConfig({ db: testDbPath }),
        }),
      );
    }
    function stubParams(rows: { name: string; value: unknown }[]) {
      jest
        .spyOn(prismaService.systemVariable, 'findMany')
        .mockResolvedValue(
          rows.map((r) => ({ type: 'parameter', ...r })) as never,
        );
    }

    it('caps rows at quota.max_rows; a smaller caller limit wins, a larger is clamped', async () => {
      stubDs();
      stubParams([
        { name: 'quota.max_rows', value: 3 },
        { name: 'cache.enabled', value: false },
      ]);
      const sql = 'SELECT id FROM nums';

      const noLimit = await service.execSql(1, sql);
      expect(noLimit.columns).toEqual(['id']);
      expect(noLimit.rows).toHaveLength(3); // quota cap applies

      const smaller = await service.execSql(1, sql, 2);
      expect(smaller.rows).toHaveLength(2); // caller's smaller limit wins

      const larger = await service.execSql(1, sql, 50);
      expect(larger.rows).toHaveLength(3); // clamped back to the quota cap
    });

    it('stores a miss under the hashed LIMIT-appended SQL and serves the hit', async () => {
      stubDs();
      stubParams([
        { name: 'quota.max_rows', value: 3 },
        { name: 'cache.enabled', value: true },
        { name: 'cache.ttl_seconds', value: 120 },
      ]);
      const qc = queryCacheMock();
      qc.currentRevision.mockResolvedValueOnce(7).mockResolvedValueOnce(7);
      qc.lookup.mockResolvedValueOnce(null); // first exec: miss
      const sql = 'SELECT id FROM nums';
      const finalSql = appendLimit(sql, 3);

      const first = await service.execSql(1, sql);
      expect(first.rows).toHaveLength(3);
      // keyed on sha256 of the LIMIT-appended effective SQL + revision/TTL
      expect(qc.store).toHaveBeenCalledWith(
        1,
        1,
        effectiveSqlHash(finalSql),
        finalSql,
        first,
        7,
        120,
      );

      const cached = { columns: ['id'], rows: [[9]] };
      qc.lookup.mockResolvedValueOnce(cached); // second exec: hit
      const second = await service.execSql(1, sql);
      expect(second).toBe(cached);
      expect(qc.store).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncTables — existing-table arm + dead connection', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('updates an existing Table row (custom comment survives) and survives an embed failure', async () => {
      const testDbPath = makeSqliteDb(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
      );
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          configuration: encryptFrontendConfig({ db: testDbPath }),
        }),
      );
      jest
        .spyOn(prismaService.table, 'findFirst')
        .mockResolvedValue({ id: 50, customComment: '自定义备注' } as never);
      const tblUpdate = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue({ id: 50 } as never);
      jest
        .spyOn(prismaService.field, 'findMany')
        .mockResolvedValue([] as never);
      jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 1 } as never);
      jest.spyOn(prismaService.field, 'update').mockResolvedValue({} as never);
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));

      await expect(service.syncTables(1)).resolves.toMatchObject({
        success: true,
        tableCount: 1,
      });
      // sqlite exposes no table comments — sync still refreshes the column
      expect(tblUpdate).toHaveBeenCalledWith({
        where: { id: 50 },
        data: { tableComment: null },
      });
      await new Promise((r) => setImmediate(r)); // flush the embed warn
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it('throws 500 on a dead connection but still bumps the cache revision', async () => {
      queryCacheMock().bumpRevision.mockClear();
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          oid: 1,
          configuration: encryptFrontendConfig({
            db: '/nonexistent-dir-does-not-exist/x.db',
          }),
        }),
      );

      await expect(service.syncTables(1)).rejects.toThrow('同步失败');
      expect(queryCacheMock().bumpRevision).toHaveBeenCalledWith(1);
    });
  });

  describe('recallTables — outer degradation', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('returns [] when the table read itself fails (nothing is dropped)', async () => {
      embeddingMock.available = true;
      vectorMock.available = true;
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockRejectedValue(new Error('db down'));

      await expect(
        service.recallTables(1, '问', {
          config: {
            enabled: true,
            dataTrainingSimilarity: 0.4,
            dataTrainingTopCount: 5,
            tableEnabled: true,
            tableCount: 10,
            tableAlpha: 0.4,
            keywordEnabled: true,
            datasourceCount: 10,
            clarifyEnabled: true,
            clarifyTableThreshold: 3,
            clarifyMaxSelect: 3,
            clarifyMaxRounds: 1,
            semanticEnabled: true,
            semanticMaxTables: 1,
            semanticEnumMaxValues: 50,
            semanticEnumScanRows: 10000,
            semanticEnumCooldown: 60,
            metricEnabled: true,
            metricMaxDefinitions: 5,
            metricSimilarityThreshold: 0.55,
            namingEnabled: true,
            quotaMaxRows: 1000,
            cacheEnabled: false,
            cacheTtlSeconds: 300,
          },
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('getTableRelation / getTableRelationVersions', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('returns the saved edge list ([] when never saved)', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValueOnce(
          mockDatasourceRow({
            tableRelation: [
              {
                fromTable: 'orders',
                fromField: 'user_id',
                toTable: 'users',
                toField: 'id',
              },
            ],
          }),
        )
        .mockResolvedValueOnce(mockDatasourceRow({ tableRelation: null }));
      await expect(service.getTableRelation(1)).resolves.toEqual([
        {
          fromTable: 'orders',
          fromField: 'user_id',
          toTable: 'users',
          toField: 'id',
        },
      ]);
      await expect(service.getTableRelation(1)).resolves.toEqual([]);
    });

    it('paginates history with normalized bounds (page>=1, size<=100)', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      const findMany = jest
        .spyOn(prismaService.datasourceRelationVersion, 'findMany')
        .mockResolvedValue([
          {
            id: 3,
            version: 3,
            snapshot: [],
            changedBy: 1,
            note: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ] as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'count')
        .mockResolvedValue(25);
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((arg: unknown) =>
          Array.isArray(arg)
            ? Promise.all(arg as Promise<unknown>[])
            : (arg as (c: unknown) => Promise<unknown>)(prismaService),
        );

      const out = await service.getTableRelationVersions(1, 0, 500);
      expect(out).toMatchObject({
        current_page: 1,
        page_size: 100,
        total_count: 25,
      });
      expect(out.data[0]).toMatchObject({ id: 3, version: 3 });
      expect(findMany).toHaveBeenCalledWith({
        where: { datasourceId: 1 },
        orderBy: { version: 'desc' },
        skip: 0,
        take: 100,
        select: {
          id: true,
          version: true,
          snapshot: true,
          changedBy: true,
          note: true,
          createdAt: true,
        },
      });
    });
  });

  describe('relation restore / compare — ownership + missing-target arms', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('404s restoring when the datasource is outside the workspace', async () => {
      const tx = {
        datasource: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
        datasourceRelationVersion: { findFirst: jest.fn(), create: jest.fn() },
      };
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((arg: unknown) =>
          (arg as (c: unknown) => Promise<unknown>)(tx),
        );

      await expect(service.restoreTableRelation(1, 2)).rejects.toThrow(
        '数据源 #1 不存在',
      );
    });

    it('404s compare when no snapshot exists at all', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findFirst')
        .mockResolvedValue(null);

      await expect(service.compareTableRelation(1, 2)).rejects.toThrow(
        '数据源 #1 不存在关系版本 2',
      );
    });

    it('404s compare when the to-version row is missing', async () => {
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(mockDatasourceRow({}));
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findFirst')
        .mockResolvedValue({ version: 3 } as never);
      jest
        .spyOn(prismaService.datasourceRelationVersion, 'findMany')
        .mockResolvedValue([{ version: 2, snapshot: [] }] as never);
      jest
        .spyOn(prismaService.table, 'findMany')
        .mockResolvedValue([] as never);

      await expect(service.compareTableRelation(1, 2)).rejects.toThrow(
        '数据源 #1 不存在关系版本 3',
      );
    });
  });

  describe('editTable / editField — ownership + embed arms', () => {
    beforeEach(() => setI18n(createTestI18n()));
    let txSpy: jest.SpyInstance;
    beforeEach(() => {
      txSpy = jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation(((fn: (tx: PrismaService) => unknown) =>
          fn(prismaService)) as never);
    });
    afterEach(() => txSpy.mockRestore());

    it('editTable 404s a table outside the workspace', async () => {
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
      await expect(service.editTable({ id: 10 })).rejects.toThrow(
        '表 #10 不存在',
      );
    });

    it('editField 404s a field outside the workspace', async () => {
      jest.spyOn(prismaService.field, 'findFirst').mockResolvedValue(null);
      await expect(service.editField({ id: 20 })).rejects.toThrow(
        '字段 #20 不存在',
      );
    });

    it('editTable tolerates an embed failure (fire-and-forget warn only)', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));
      jest
        .spyOn(prismaService.table, 'findFirst')
        .mockResolvedValue({ id: 10 } as never);
      const tblUpdate = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue({
          id: 10,
          tableName: 'orders',
          tableComment: '销售',
          customComment: null,
        } as never);

      await expect(
        service.editTable({ id: 10, checked: true }),
      ).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r)); // flush the warn
      expect(tblUpdate).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { checked: true },
      });
    });

    it('editTable re-embeds with the tableComment when customComment is null', async () => {
      embeddingMock.available = true;
      embeddingMock.embed.mockResolvedValue([0.1, 0.2]);
      vectorMock.available = true;
      jest
        .spyOn(prismaService.table, 'findFirst')
        .mockResolvedValue({ id: 10 } as never);
      const tblUpdate = jest
        .spyOn(prismaService.table, 'update')
        .mockResolvedValue({
          id: 10,
          tableName: 'orders',
          tableComment: '销售',
          customComment: null,
        } as never);

      await service.editTable({ id: 10, custom_comment: null });
      await new Promise((r) => setImmediate(r)); // flush the re-embed

      expect(embeddingMock.embed).toHaveBeenCalledWith('orders\n销售');
      expect(tblUpdate).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { embedding: [0.1, 0.2] },
      });
      expect(vectorMock.upsert).toHaveBeenCalledWith('table', 10, [0.1, 0.2]);
    });
  });

  describe('previewData / syncFieldsByTableId — missing-row guards', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('previewData 404s an unknown table id', async () => {
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
      await expect(
        service.previewData(1, { table: { id: 9 } }),
      ).rejects.toThrow('表 #9 不存在');
    });

    it('syncFieldsByTableId 404s an unknown table id', async () => {
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue(null);
      await expect(service.syncFieldsByTableId(9)).rejects.toThrow(
        '表 #9 不存在',
      );
    });
  });

  describe('syncFieldsByTableId — field merge + embed degradation', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('deletes stale fields, updates survivors, creates new ones; embed failure tolerated', async () => {
      const testDbPath = makeSqliteDb(
        'CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT)',
      );
      jest.spyOn(prismaService.table, 'findFirst').mockResolvedValue({
        id: 9,
        datasourceId: 1,
        tableName: 'items',
        customComment: null,
        tableComment: '物',
      } as never);
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          oid: 1,
          configuration: encryptFrontendConfig({ db: testDbPath }),
        }),
      );
      jest.spyOn(prismaService.field, 'findMany').mockResolvedValue([
        { id: 1, fieldName: 'gone' },
        { id: 2, fieldName: 'sku' },
      ] as never);
      const fieldDelete = jest
        .spyOn(prismaService.field, 'deleteMany')
        .mockResolvedValue({ count: 1 });
      const fieldUpdate = jest
        .spyOn(prismaService.field, 'update')
        .mockResolvedValue({} as never);
      const fieldCreate = jest
        .spyOn(prismaService.field, 'create')
        .mockResolvedValue({ id: 3 } as never);
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));

      await expect(service.syncFieldsByTableId(9)).resolves.toBeUndefined();
      // 'gone' no longer exists in the source; 'sku' refreshes in place;
      // 'id' is new (created).
      expect(fieldDelete).toHaveBeenCalledWith({ where: { id: { in: [1] } } });
      expect(fieldUpdate).toHaveBeenCalledWith({
        where: { id: 2 },
        data: expect.objectContaining({ fieldType: 'TEXT' }),
      });
      expect(fieldCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ fieldName: 'id', isPrimaryKey: true }),
      });
      await new Promise((r) => setImmediate(r)); // flush the embed warn
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });
  });

  describe('syncTable — embed degradation', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('tolerates an embed failure during the selection sync (warn only)', async () => {
      const testDbPath = makeSqliteDb(
        'CREATE TABLE users (id INTEGER PRIMARY KEY)',
      );
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(
        mockDatasourceRow({
          oid: 1,
          configuration: encryptFrontendConfig({ db: testDbPath }),
        }),
      );
      spySyncDelegates();
      embeddingMock.available = true;
      embeddingMock.embed.mockRejectedValue(new Error('embed down'));

      await expect(
        service.syncTable(1, [{ table_name: 'users', table_comment: '用户' }]),
      ).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r)); // flush the warn
      expect(prismaService.table.create).toHaveBeenCalled();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });
  });

  describe('remove — non-excel datasource', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('deletes regression cases + the row in one tx and drops no physical tables', async () => {
      excelStoreMock.dropTables.mockClear();
      queryCacheMock().bumpRevision.mockClear();
      jest
        .spyOn(prismaService, '$transaction')
        .mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(prismaService)) as never);
      jest
        .spyOn(prismaService.datasource, 'findFirst')
        .mockResolvedValue(
          mockDatasourceRow({ id: 5, oid: 1, type: 'sqlite' }),
        );
      const caseDelete = jest
        .spyOn(prismaService.regressionCase, 'deleteMany')
        .mockResolvedValue({ count: 0 });
      jest
        .spyOn(prismaService.datasource, 'delete')
        .mockResolvedValue({} as never);

      await service.remove(5);

      expect(caseDelete).toHaveBeenCalledWith({
        where: { oid: 1, datasourceId: 5 },
      });
      expect(excelStoreMock.dropTables).not.toHaveBeenCalled();
      expect(queryCacheMock().bumpRevision).toHaveBeenCalledWith(1);
    });
  });

  describe('tableList — ownership guard', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('404s a datasource outside the workspace', async () => {
      jest.spyOn(prismaService.datasource, 'findFirst').mockResolvedValue(null);
      await expect(service.tableList(5)).rejects.toThrow('数据源 #5 不存在');
    });
  });

  describe('workspace resolution (ALS)', () => {
    beforeEach(() => setI18n(createTestI18n()));

    it('rejects with 401 when no request context is attached', async () => {
      const raw = app.get(DatasourceService);
      await expect(raw.findAll()).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
