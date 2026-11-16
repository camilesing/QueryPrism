// ExcelStoreService spec — upload validation + filename sanitization, the pg
// import transaction (CREATE SCHEMA / BEGIN / CREATE TABLE / batched INSERT /
// COMMIT, ROLLBACK on failure), resolveUpload traversal guards, best-effort
// dropTables, the M7 cache-revision bump on re-import, and the
// toDbValue / pgType / tableName / quoteIdent helpers. `pg` is module-mocked
// with per-test programmable connect/query/end behavior; uploads are written
// to a throwaway os.tmpdir() directory removed in afterAll.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { requestContextStorage } from '../common/context/request-context';
import type { QueryCacheService } from '../quota/query-cache.service';
import * as excelParser from './excel-parser';
import {
  ExcelStoreService,
  type ImportSheetRequest,
  type ImportSheetResult,
} from './excel-store.service';

interface FakeClient {
  connect: jest.Mock;
  query: jest.Mock;
  end: jest.Mock;
}

interface PgMock {
  Client: jest.Mock;
  __clients: FakeClient[];
  __state: {
    queryImpl: (sql: string, params?: unknown[]) => Promise<unknown>;
    connectImpl: () => Promise<void>;
    endImpl: () => Promise<void>;
  };
}

jest.mock('pg', () => {
  const clients: FakeClient[] = [];
  const state = {
    queryImpl: () => Promise.resolve({ rows: [] }),
    connectImpl: () => Promise.resolve(undefined),
    endImpl: () => Promise.resolve(undefined),
  };
  const Client = jest.fn().mockImplementation(() => {
    const client: FakeClient = {
      connect: jest.fn(() => state.connectImpl()),
      query: jest.fn((sql: string, params?: unknown[]) =>
        state.queryImpl(sql, params),
      ),
      end: jest.fn(() => state.endImpl()),
    };
    clients.push(client);
    return client;
  });
  return { Client, __clients: clients, __state: state };
});

const pg = jest.requireMock<PgMock>('pg');
const lastClient = () => pg.__clients[pg.__clients.length - 1];
const sqls = () => lastClient().query.mock.calls.map((c) => c[0] as string);

/** A rejection reason that is NOT an Error at runtime (only typed as one so
 *  prefer-promise-reject-errors stays quiet) — exercises the service's
 *  `String(e)` error-formatting branches. */
const stringReason = (text: string): Error => text as unknown as Error;

/** Await a promise and capture its rejection reason instead of throwing. */
async function captureError(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

const DB_URL = 'postgresql://u:p@h:5432/db';
const tmpDir = join(tmpdir(), `qp-excel-store-${randomUUID()}`);

/** Privates exercised directly where the public flow cannot reach them
 *  (pure coercion helpers, cleanup-tolerance paths). */
type Privates = {
  saveUpload(
    file: Express.Multer.File,
  ): Promise<{ filename: string; path: string }>;
  parseFile(filename: string): Promise<excelParser.ParsedSheet[]>;
  importParsed(
    filename: string,
    parsed: excelParser.ParsedSheet[],
    requested: ImportSheetRequest[],
  ): Promise<ImportSheetResult[]>;
  toDbValue(
    value: excelParser.ExcelCell,
    type: excelParser.ExcelFieldType,
    rowNum: number,
    fieldName: string,
  ): unknown;
  pgType(type: excelParser.ExcelFieldType): string;
  tableName(sheetName: string): string;
  quoteIdent(name: string): string;
  qualified(name: string): string;
};
const priv = (svc: ExcelStoreService) => svc as unknown as Privates;

function makeService(overrides: Record<string, string | undefined> = {}): {
  service: ExcelStoreService;
  queryCache: { bumpRevision: jest.Mock };
} {
  const values: Record<string, string | undefined> = {
    'excel.uploadDir': tmpDir,
    'excel.storeSchema': 'excel_store',
    DATABASE_URL: DB_URL,
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const queryCache = { bumpRevision: jest.fn().mockResolvedValue(undefined) };
  const service = new ExcelStoreService(
    config,
    queryCache as unknown as QueryCacheService,
  );
  return { service, queryCache };
}

async function buildXlsx(
  sheets: { name: string; rows: unknown[][] }[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Sheet1: id/name/score/when (int/string/float/datetime) + an empty sheet. */
function standardWorkbook(): Promise<Buffer> {
  return buildXlsx([
    {
      name: 'Sheet1',
      rows: [
        ['id', 'name', 'score', 'when'],
        [1, 'Alice', 90.5, new Date('2026-01-02T00:00:00Z')],
        [2, 'Bob', 75, new Date('2026-01-03T00:00:00Z')],
      ],
    },
    { name: 'Empty', rows: [] },
  ]);
}

function xlsxFile(buffer: Buffer, originalname: string): Express.Multer.File {
  return { buffer, originalname, size: buffer.length } as Express.Multer.File;
}

const sheetReq = (): ImportSheetRequest[] => [
  {
    sheetName: 'Sheet1',
    fields: [
      { fieldName: 'id', fieldType: 'int' },
      { fieldName: 'name', fieldType: 'string' },
    ],
  },
];

async function saveStandard(service: ExcelStoreService): Promise<string> {
  const res = await service.receive(
    xlsxFile(await standardWorkbook(), 'd.xlsx'),
  );
  return res.filePath;
}

async function withDatabaseUrl(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
}

async function runAsUser<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 9, account: 'tester', oid: 7, language: 'en' } },
    fn,
  );
}

describe('ExcelStoreService', () => {
  beforeEach(() => {
    setI18n(createTestI18n());
    jest.clearAllMocks();
    pg.__clients.length = 0;
    pg.__state.queryImpl = () => Promise.resolve({ rows: [] });
    pg.__state.connectImpl = () => Promise.resolve(undefined);
    pg.__state.endImpl = () => Promise.resolve(undefined);
  });

  beforeAll(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('rejects an invalid excel.storeSchema identifier', () => {
      expect(() => makeService({ 'excel.storeSchema': 'bad schema' })).toThrow(
        'Invalid excel.storeSchema: bad schema',
      );
    });

    it('falls back to the default upload dir and schema when unset', async () => {
      const { service } = makeService({
        'excel.uploadDir': undefined,
        'excel.storeSchema': undefined,
      });
      await service.dropTables(['t1']);
      expect(sqls()).toEqual(['DROP TABLE IF EXISTS "excel_store"."t1"']);
    });
  });

  describe('receive', () => {
    it('saves the upload under a sanitized random name and returns the preview', async () => {
      const { service } = makeService();
      const res = await service.receive(
        xlsxFile(await standardWorkbook(), 'demo upload.xlsx'),
      );
      expect(res.filePath).toMatch(/^demo_upload_[0-9a-f]{10}\.xlsx$/);
      await expect(
        fs.access(join(tmpDir, res.filePath)),
      ).resolves.toBeUndefined();
      expect(res.data).toHaveLength(2);
      expect(res.data[0].sheetName).toBe('Sheet1');
      expect(res.data[0].fields).toEqual([
        { fieldName: 'id', fieldType: 'int' },
        { fieldName: 'name', fieldType: 'string' },
        { fieldName: 'score', fieldType: 'float' },
        { fieldName: 'when', fieldType: 'datetime' },
      ]);
      expect(res.data[0].rows).toBe(2);
      expect(res.data[0].data[0]).toMatchObject({
        id: 1,
        name: 'Alice',
        score: 90.5,
      });
      expect(res.data[1]).toEqual({
        sheetName: 'Empty',
        fields: [],
        data: [],
        rows: 0,
      });
    });

    it('wraps parse failures of a corrupt buffer in BadRequestException', async () => {
      const { service } = makeService();
      const err = (await captureError(
        service.receive(xlsxFile(Buffer.from('not an excel'), 'broken.xlsx')),
      )) as BadRequestException;
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/Excel 文件解析失败/);
    });

    it('requires a file with a buffer', async () => {
      const { service } = makeService();
      await expect(
        service.receive(undefined as unknown as Express.Multer.File),
      ).rejects.toThrow('Please upload an Excel file');
      await expect(
        service.receive({
          originalname: 'a.xlsx',
          size: 3,
        } as unknown as Express.Multer.File),
      ).rejects.toThrow('Please upload an Excel file');
    });

    it('enforces the 50MB size limit', async () => {
      const { service } = makeService();
      const file = xlsxFile(Buffer.from('x'), 'a.xlsx');
      file.size = 50 * 1024 * 1024 + 1;
      await expect(service.receive(file)).rejects.toThrow(
        'File size must not exceed 50MB',
      );
    });

    it('rejects legacy .xls and unsupported extensions', async () => {
      const { service } = makeService();
      await expect(
        service.receive(xlsxFile(Buffer.from('x'), 'old.xls')),
      ).rejects.toThrow(/暂不支持 \.xls/);
      await expect(
        service.receive(xlsxFile(Buffer.from('x'), 'notes.txt')),
      ).rejects.toThrow('Only .xlsx / .csv files are supported');
      await expect(
        service.receive(xlsxFile(Buffer.from('x'), 'no-extension')),
      ).rejects.toThrow('Only .xlsx / .csv files are supported');
    });

    it('treats a missing original name as an unsupported upload', async () => {
      const { service } = makeService();
      await expect(
        service.receive({
          buffer: Buffer.from('x'),
          size: 1,
          originalname: null,
        } as unknown as Express.Multer.File),
      ).rejects.toThrow('Only .xlsx / .csv files are supported');
    });
  });

  describe('importWholeFile', () => {
    it('imports every sheet with fields in one transaction and removes the upload', async () => {
      const { service } = makeService();
      const res = await service.importWholeFile(
        xlsxFile(await standardWorkbook(), 'demo upload.xlsx'),
      );
      expect(res.filename).toMatch(/^demo_upload_[0-9a-f]{10}\.xlsx$/);
      expect(res.sheets).toEqual([
        {
          sheetName: 'Sheet1',
          tableName: expect.stringMatching(/^excel_Sheet1_[0-9a-f]{10}$/),
          tableComment: '',
          rows: 2,
        },
      ]);
      const statements = sqls();
      expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "excel_store"');
      expect(statements[1]).toBe('BEGIN');
      expect(statements[2]).toMatch(
        /^CREATE TABLE "excel_store"\."excel_Sheet1_[0-9a-f]{10}" \("id" BIGINT, "name" TEXT, "score" DOUBLE PRECISION, "when" TIMESTAMP\)$/,
      );
      expect(statements[3]).toMatch(/^INSERT INTO "excel_store"\./);
      expect(statements[4]).toBe('COMMIT');
      expect(statements).toHaveLength(5);
      // the file is only needed until the import commits
      await expect(fs.access(join(tmpDir, res.filename))).rejects.toThrow();
    });

    it('rejects workbooks with no importable data', async () => {
      const { service } = makeService();
      const buf = await buildXlsx([{ name: 'Empty', rows: [] }]);
      await expect(
        service.importWholeFile(xlsxFile(buf, 'e.xlsx')),
      ).rejects.toThrow('No importable data in the Excel file');
    });
  });

  describe('importToDb', () => {
    it('requires a non-empty sheets array', async () => {
      const { service } = makeService();
      await expect(service.importToDb('d.xlsx', [])).rejects.toThrow(
        'Select at least one worksheet to import',
      );
      await expect(
        service.importToDb('d.xlsx', null as unknown as ImportSheetRequest[]),
      ).rejects.toThrow('Select at least one worksheet to import');
    });

    it('imports typed columns and bumps the workspace cache revision', async () => {
      const { service, queryCache } = makeService();
      const buf = await buildXlsx([
        {
          name: 'My Sheet',
          rows: [
            ['id', 'name', 'score', 'when'],
            [1, 'Alice', 90.5, new Date('2026-01-02T00:00:00Z')],
            [2, 'Bob', 75, new Date('2026-01-03T00:00:00Z')],
          ],
        },
      ]);
      const saved = await service.receive(xlsxFile(buf, 'demo.xlsx'));
      const result = await runAsUser(() =>
        service.importToDb(saved.filePath, [
          {
            sheetName: 'My Sheet',
            fields: [
              { fieldName: 'id', fieldType: 'int' },
              { fieldName: 'name', fieldType: 'string' },
              { fieldName: 'score', fieldType: 'float' },
              { fieldName: 'when', fieldType: 'datetime' },
            ],
          },
        ]),
      );
      expect(result.filename).toBe(saved.filePath);
      expect(result.sheets).toEqual([
        {
          sheetName: 'My Sheet',
          tableName: expect.stringMatching(/^excel_My_Sheet_[0-9a-f]{10}$/),
          tableComment: '',
          rows: 2,
        },
      ]);
      // connection string comes from ConfigService
      expect(pg.Client).toHaveBeenCalledWith({ connectionString: DB_URL });
      const statements = sqls();
      expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "excel_store"');
      expect(statements[1]).toBe('BEGIN');
      expect(statements[2]).toMatch(
        /^CREATE TABLE "excel_store"\."excel_My_Sheet_[0-9a-f]{10}" \("id" BIGINT, "name" TEXT, "score" DOUBLE PRECISION, "when" TIMESTAMP\)$/,
      );
      expect(statements[3]).toMatch(
        /^INSERT INTO "excel_store"\."excel_My_Sheet_[0-9a-f]{10}" \("id", "name", "score", "when"\) VALUES \(\$1, \$2, \$3, \$4\), \(\$5, \$6, \$7, \$8\)$/,
      );
      expect(statements[4]).toBe('COMMIT');
      expect(statements).toHaveLength(5);
      const insertParams = lastClient().query.mock.calls[3][1] as unknown[];
      expect(insertParams.slice(0, 4)).toEqual([
        1,
        'Alice',
        90.5,
        expect.any(Date),
      ]);
      expect(queryCache.bumpRevision).toHaveBeenCalledTimes(1);
      expect(queryCache.bumpRevision).toHaveBeenCalledWith(7);
      await expect(fs.access(join(tmpDir, saved.filePath))).rejects.toThrow();
    });

    it('skips the cache bump outside a request scope', async () => {
      const { service, queryCache } = makeService();
      const fp = await saveStandard(service);
      await service.importToDb(fp, sheetReq());
      expect(queryCache.bumpRevision).not.toHaveBeenCalled();
    });

    it('logs and continues when the cache revision bump fails', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service, queryCache } = makeService();
      const fp1 = await saveStandard(service);
      const fp2 = await saveStandard(service);
      queryCache.bumpRevision.mockRejectedValueOnce(new Error('cache down'));
      queryCache.bumpRevision.mockRejectedValueOnce(
        stringReason('plain string'),
      );
      await runAsUser(() => service.importToDb(fp1, sheetReq()));
      await runAsUser(() => service.importToDb(fp2, sheetReq()));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'cache revision bump failed (oid=7): cache down',
        ),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'cache revision bump failed (oid=7): plain string',
        ),
      );
      warn.mockRestore();
    });

    it('rejects an unknown worksheet name before touching the database', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      await expect(
        service.importToDb(fp, [
          {
            sheetName: 'Nope',
            fields: [{ fieldName: 'id', fieldType: 'int' }],
          },
        ]),
      ).rejects.toThrow('Worksheet "Nope" not found');
      expect(pg.__clients).toHaveLength(0);
    });

    it('rejects invalid field types before touching the database', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      await expect(
        service.importToDb(fp, [
          {
            sheetName: 'Sheet1',
            fields: [
              {
                fieldName: 'id',
                fieldType: 'boolean' as unknown as excelParser.ExcelFieldType,
              },
            ],
          },
        ]),
      ).rejects.toThrow(/类型无效: boolean/);
      expect(pg.__clients).toHaveLength(0);
    });

    it('rejects fields that do not exist in the worksheet', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      await expect(
        service.importToDb(fp, [
          {
            sheetName: 'Sheet1',
            fields: [
              { fieldName: 'ghost', fieldType: 'int' },
              { fieldName: 'id', fieldType: 'int' },
            ],
          },
        ]),
      ).rejects.toThrow(/工作表「Sheet1」中不存在字段「ghost」/);
      expect(pg.__clients).toHaveLength(0);
    });

    it('rejects a worksheet request without fields (defaults to none)', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      await expect(
        service.importToDb(fp, [{ sheetName: 'Sheet1' } as ImportSheetRequest]),
      ).rejects.toThrow('Worksheet "Sheet1" has no fields');
      expect(pg.__clients).toHaveLength(0);
    });

    it('rejects non-numeric values in numeric columns and rolls back', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      await expect(
        service.importToDb(fp, [
          {
            sheetName: 'Sheet1',
            fields: [{ fieldName: 'name', fieldType: 'int' }],
          },
        ]),
      ).rejects.toThrow(/第 \d+ 行「name」不是有效数字/);
      // the failure surfaces during insertion, inside the transaction
      expect(sqls()).toContain('ROLLBACK');
      expect(sqls()).not.toContain('COMMIT');
    });

    it('rolls back and wraps unexpected database failures, keeping the file', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      pg.__state.queryImpl = (sql) =>
        sql.startsWith('INSERT INTO')
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ rows: [] });
      const err = (await captureError(
        service.importToDb(fp, sheetReq()),
      )) as BadRequestException;
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('导入数据失败: boom');
      expect(sqls()).toEqual([
        'CREATE SCHEMA IF NOT EXISTS "excel_store"',
        'BEGIN',
        expect.stringMatching(/^CREATE TABLE /),
        expect.stringMatching(/^INSERT INTO /),
        'ROLLBACK',
      ]);
      expect(lastClient().end).toHaveBeenCalledTimes(1);
      // a failed import must not consume the upload
      await expect(fs.access(join(tmpDir, fp))).resolves.toBeUndefined();
    });

    it('wraps non-Error database failures with String()', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      pg.__state.queryImpl = (sql) =>
        sql.startsWith('INSERT INTO')
          ? Promise.reject(stringReason('pg broke'))
          : Promise.resolve({ rows: [] });
      await expect(service.importToDb(fp, sheetReq())).rejects.toThrow(
        '导入数据失败: pg broke',
      );
    });

    it('rethrows validation failures unchanged after rolling back', async () => {
      const { service } = makeService();
      const buf = await buildXlsx([
        { name: 'S', rows: [['big'], ['9999999999999999999']] },
      ]);
      const saved = await service.receive(xlsxFile(buf, 'big.xlsx'));
      const err = (await captureError(
        service.importToDb(saved.filePath, [
          {
            sheetName: 'S',
            fields: [{ fieldName: 'big', fieldType: 'int' }],
          },
        ]),
      )) as BadRequestException;
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/超出整数范围/);
      expect(err.message).not.toContain('导入数据失败');
      expect(sqls()).toContain('ROLLBACK');
    });

    it('fails fast when DATABASE_URL is missing (no client, no rollback)', async () => {
      await withDatabaseUrl(undefined, async () => {
        const { service } = makeService({ DATABASE_URL: undefined });
        const fp = await saveStandard(service);
        await expect(service.importToDb(fp, sheetReq())).rejects.toThrow(
          'DATABASE_URL is not configured; Excel import unavailable',
        );
        expect(pg.Client).not.toHaveBeenCalled();
      });
    });

    it('falls back to process.env.DATABASE_URL when config omits it', async () => {
      await withDatabaseUrl('postgresql://env:pw@h:5432/envdb', async () => {
        const { service } = makeService({ DATABASE_URL: undefined });
        const fp = await saveStandard(service);
        await service.importToDb(fp, sheetReq());
        expect(pg.Client).toHaveBeenCalledWith({
          connectionString: 'postgresql://env:pw@h:5432/envdb',
        });
      });
    });

    it('rejects empty, missing and traversing filenames', async () => {
      const { service } = makeService();
      await expect(service.importToDb('', sheetReq())).rejects.toThrow(
        'File not found',
      );
      await expect(
        service.importToDb('../outside.xlsx', sheetReq()),
      ).rejects.toThrow('File not found');
      // '..' passes the basename check but escapes uploadDir via dirname
      await expect(service.importToDb('..', sheetReq())).rejects.toThrow(
        'File not found',
      );
      await expect(
        service.importToDb('ghost.xlsx', sheetReq()),
      ).rejects.toThrow('File not found');
    });

    it('creates the table for a header-only sheet without inserting', async () => {
      const { service } = makeService();
      const buf = await buildXlsx([{ name: 'H', rows: [['id', 'name']] }]);
      const saved = await service.receive(xlsxFile(buf, 'h.xlsx'));
      const result = await service.importToDb(saved.filePath, [
        {
          sheetName: 'H',
          fields: [
            { fieldName: 'id', fieldType: 'int' },
            { fieldName: 'name', fieldType: 'string' },
          ],
        },
      ]);
      expect(result.sheets[0].rows).toBe(0);
      expect(sqls().filter((s) => s.startsWith('INSERT INTO'))).toHaveLength(0);
      expect(sqls()).toContain('COMMIT');
    });

    it('batches inserts at 500 rows per statement with sequential placeholders', async () => {
      const { service } = makeService();
      const rows: unknown[][] = [['id', 'name']];
      for (let i = 1; i <= 501; i++) rows.push([i, `n${i}`]);
      const buf = await buildXlsx([{ name: 'Big', rows }]);
      const saved = await service.receive(xlsxFile(buf, 'big.xlsx'));
      await service.importToDb(saved.filePath, [
        {
          sheetName: 'Big',
          fields: [
            { fieldName: 'id', fieldType: 'int' },
            { fieldName: 'name', fieldType: 'string' },
          ],
        },
      ]);
      const insertCalls = lastClient().query.mock.calls.filter((c) =>
        (c[0] as string).startsWith('INSERT INTO'),
      );
      expect(insertCalls).toHaveLength(2);
      const first = insertCalls[0][0] as string;
      expect(first).toMatch(
        /^INSERT INTO "excel_store"\."excel_Big_[0-9a-f]{10}" \("id", "name"\) VALUES \(\$1, \$2\), \(\$3, \$4\)/,
      );
      expect(first).toContain('($999, $1000)');
      expect(first.endsWith('($999, $1000)')).toBe(true);
      expect(insertCalls[0][1]).toHaveLength(1000);
      expect(insertCalls[1][0]).toMatch(
        /^INSERT INTO "excel_store"\."excel_Big_[0-9a-f]{10}" \("id", "name"\) VALUES \(\$1, \$2\)$/,
      );
      expect(insertCalls[1][1]).toEqual([501, 'n501']);
    });

    it('tolerates a missing upload and a failing end at cleanup time', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      const parsed = await priv(service).parseFile(fp);
      await fs.rm(join(tmpDir, fp));
      pg.__state.endImpl = () => Promise.reject(stringReason('end boom'));
      const results = await priv(service).importParsed(fp, parsed, sheetReq());
      expect(results[0].rows).toBe(2);
      expect(sqls()).toContain('COMMIT');
    });

    it('still closes the client when ROLLBACK itself fails', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      pg.__state.queryImpl = (sql) => {
        if (sql === 'ROLLBACK') return Promise.reject(stringReason('rb fail'));
        if (sql.startsWith('INSERT INTO'))
          return Promise.reject(new Error('boom'));
        return Promise.resolve({ rows: [] });
      };
      await expect(service.importToDb(fp, sheetReq())).rejects.toThrow(
        '导入数据失败: boom',
      );
      expect(lastClient().end).toHaveBeenCalledTimes(1);
    });
  });

  describe('dropTables', () => {
    it('drops only identifier-safe names, schema-qualified', async () => {
      const { service } = makeService();
      await service.dropTables(['keep_a', 'bad name', 'x; DROP', 'ok_b']);
      expect(sqls()).toEqual([
        'DROP TABLE IF EXISTS "excel_store"."keep_a"',
        'DROP TABLE IF EXISTS "excel_store"."ok_b"',
      ]);
      expect(lastClient().end).toHaveBeenCalledTimes(1);
    });

    it('skips the database entirely when no valid names remain', async () => {
      const { service } = makeService();
      await service.dropTables([]);
      await service.dropTables(['../evil', 'no spaces']);
      expect(pg.Client).not.toHaveBeenCalled();
    });

    it('swallows query failures (best effort) and still closes the client', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service } = makeService();
      pg.__state.queryImpl = () => Promise.reject(new Error('db down'));
      await expect(service.dropTables(['t'])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('excel table cleanup failed: db down'),
      );
      expect(lastClient().end).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('survives a failing connect without a client to close', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service } = makeService();
      pg.__state.connectImpl = () => Promise.reject(stringReason('no dns'));
      await expect(service.dropTables(['t'])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('excel table cleanup failed: no dns'),
      );
      warn.mockRestore();
    });

    it('tolerates a failing end in the cleanup path', async () => {
      const { service } = makeService();
      pg.__state.endImpl = () => Promise.reject(stringReason('end boom'));
      await expect(service.dropTables(['t'])).resolves.toBeUndefined();
      expect(sqls()).toEqual(['DROP TABLE IF EXISTS "excel_store"."t"']);
    });
  });

  describe('parseFile', () => {
    it('stringifies non-Error parse failures in the wrapped message', async () => {
      const { service } = makeService();
      const fp = await saveStandard(service);
      const spy = jest
        .spyOn(excelParser, 'parseExcelBuffer')
        .mockRejectedValueOnce(stringReason('not an error'));
      await expect(priv(service).parseFile(fp)).rejects.toThrow(
        'Excel 文件解析失败: not an error',
      );
      spy.mockRestore();
    });
  });

  describe('saveUpload', () => {
    it('sanitizes the original name into a random stored filename', async () => {
      const { service } = makeService();
      const saved = await priv(service).saveUpload(
        xlsxFile(Buffer.from('x'), '../../weird name!!(1).xlsx'),
      );
      expect(saved.filename).toMatch(/^weird_name_1_[0-9a-f]{10}\.xlsx$/);
      expect(saved.path.startsWith(tmpDir)).toBe(true);
      await expect(fs.access(saved.path)).resolves.toBeUndefined();
    });

    it('falls back to neutral names when nothing survives sanitization', async () => {
      const { service } = makeService();
      const b = await priv(service).saveUpload(
        xlsxFile(Buffer.from('x'), '!!!???.xlsx'),
      );
      expect(b.filename).toMatch(/^excel_[0-9a-f]{10}\.xlsx$/);
      const c = await priv(service).saveUpload({
        buffer: Buffer.from('x'),
        size: 1,
      } as Express.Multer.File);
      expect(c.filename).toMatch(/^upload_[0-9a-f]{10}$/);
    });
  });

  describe('helpers', () => {
    it('toDbValue maps empty cells to NULL and stringifies strings', () => {
      const p = priv(makeService().service);
      expect(p.toDbValue(null, 'int', 2, 'c')).toBeNull();
      expect(p.toDbValue(undefined, 'string', 2, 'c')).toBeNull();
      expect(p.toDbValue('', 'float', 2, 'c')).toBeNull();
      expect(p.toDbValue('   ', 'datetime', 2, 'c')).toBeNull();
      expect(p.toDbValue(123, 'string', 2, 'c')).toBe('123');
      expect(p.toDbValue(true, 'string', 2, 'c')).toBe('true');
    });

    it('toDbValue parses int columns with rounding and range guards', () => {
      const p = priv(makeService().service);
      expect(p.toDbValue(42, 'int', 2, 'c')).toBe(42);
      expect(p.toDbValue('42', 'int', 2, 'c')).toBe(42);
      expect(p.toDbValue(1.6, 'int', 2, 'c')).toBe(2);
      expect(() => p.toDbValue('abc', 'int', 3, 'c')).toThrow(/不是有效数字/);
      expect(() => p.toDbValue(Infinity, 'int', 3, 'c')).toThrow(
        /不是有效数字/,
      );
      expect(() => p.toDbValue('9999999999999999999', 'int', 3, 'c')).toThrow(
        /超出整数范围/,
      );
    });

    it('toDbValue parses float and datetime columns', () => {
      const p = priv(makeService().service);
      expect(p.toDbValue('3.5', 'float', 2, 'c')).toBe(3.5);
      expect(p.toDbValue(2, 'float', 2, 'c')).toBe(2);
      const d = new Date('2026-01-02T03:04:05Z');
      expect(p.toDbValue(d, 'datetime', 2, 'c')).toBe(d);
      // Excel serial date: days since 1899-12-30
      expect(p.toDbValue(45000, 'datetime', 2, 'c')).toEqual(
        new Date(Date.UTC(1899, 11, 30) + 45000 * 86_400_000),
      );
      expect(p.toDbValue('2026-01-02', 'datetime', 2, 'c')).toEqual(
        new Date('2026-01-02T00:00:00Z'),
      );
      expect(() => p.toDbValue('not a date', 'datetime', 3, 'c')).toThrow(
        /不是有效日期/,
      );
    });

    it('pgType maps field types to PostgreSQL column types', () => {
      const p = priv(makeService().service);
      expect(p.pgType('int')).toBe('BIGINT');
      expect(p.pgType('float')).toBe('DOUBLE PRECISION');
      expect(p.pgType('datetime')).toBe('TIMESTAMP');
      expect(p.pgType('string')).toBe('TEXT');
    });

    it('tableName normalizes, dedupes randomness and caps length', () => {
      const p = priv(makeService().service);
      expect(p.tableName('My Sheet 1!')).toMatch(
        /^excel_My_Sheet_1_[0-9a-f]{10}$/,
      );
      expect(p.tableName('???')).toMatch(/^excel_sheet_[0-9a-f]{10}$/);
      // 40 CJK chars survive slicing but exceed the 63-byte pg identifier
      expect(() => p.tableName('好'.repeat(45))).toThrow(
        'Worksheet name too long',
      );
    });

    it('quoteIdent escapes embedded quotes and qualified builds schema.name', () => {
      const p = priv(makeService().service);
      expect(p.quoteIdent('a"b')).toBe('"a""b"');
      expect(p.qualified('my table')).toBe('"excel_store"."my table"');
    });
  });
});
