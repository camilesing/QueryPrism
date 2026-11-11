import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
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
      terminologySimilarity: 0.4,
      terminologyTopCount: 5,
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
});
