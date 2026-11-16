// AuditService unit tests — WRITE side (record() reading the operator from
// the ALS RequestContext + nested resource snapshots, swallow-on-failure)
// and READ side (page: the `__`-joined multi-value filters parsed into a
// Prisma where, snapshot-consistent $transaction, oid→name map; getOptions;
// export: a real ExcelJS workbook re-parsed from the returned buffer).
// Prisma is mocked with the dual-form $transaction (page uses the array form).
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { AuditService, type AuditLogQuery } from './audit.service';
import type { AuditLogRow } from './audit-snake-mapper';
import { OperationType } from './operation.enum';

setI18n(createTestI18n());

function withUser<T>(
  user: { id: number; account: string; oid: number },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: user.account,
        oid: user.oid,
        language: 'en',
        weight: 0,
      },
    },
    fn,
  );
}

interface AuditPrismaMock {
  systemLog: {
    create: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
  };
  workspace: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrisma(): AuditPrismaMock {
  const prisma: AuditPrismaMock = {
    systemLog: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    workspace: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  // Dual form: the array form (page's count+findMany snapshot) resolves in
  // parallel; the callback form gets the SAME mock object as tx.
  prisma.$transaction.mockImplementation(
    async (
      arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
    ) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  );
  return prisma;
}

function makeService(prisma: AuditPrismaMock = makePrisma()): {
  svc: AuditService;
  prisma: AuditPrismaMock;
} {
  return { svc: new AuditService(prisma as never), prisma };
}

const CREATED_AT = new Date('2026-01-02T03:04:05Z');

function logRow(over: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: 1,
    module: 'datasource',
    type: 'create',
    status: 'success',
    operatorId: 7,
    operator: 'alice',
    detail: 'created datasource ds1',
    createdAt: CREATED_AT,
    oid: 1,
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    executionTime: 12,
    errorMessage: null,
    requestMethod: 'POST',
    requestPath: '/api/v1/datasource',
    remark: null,
    resources: [{ name: 'ds1' }],
    ...over,
  };
}

describe('AuditService.record (write side)', () => {
  it('persists the operator from the ALS context + nested resource snapshots', async () => {
    const { svc, prisma } = makeService();
    await withUser({ id: 7, account: 'alice', oid: 1 }, () =>
      svc.record({
        module: 'datasource',
        type: 'create',
        status: 'success',
        detail: 'created ds1',
        ipAddress: '10.0.0.1',
        requestMethod: 'POST',
        requestPath: '/api/v1/datasource',
        executionTime: 42,
        resources: [{ name: 'ds1', originId: 3 }, { originStr: 'orders' }],
      }),
    );
    expect(prisma.systemLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        module: 'datasource',
        type: 'create',
        status: 'success',
        operatorId: 7,
        operator: 'alice',
        oid: 1, // falls back to the ALS user's workspace
        ipAddress: '10.0.0.1',
        executionTime: 42,
        requestMethod: 'POST',
        requestPath: '/api/v1/datasource',
        resources: {
          create: [
            { name: 'ds1', originId: '3', originStr: null }, // id stringified
            { name: null, originId: null, originStr: 'orders' },
          ],
        },
      }),
    });
  });

  it('a non-request write (no ALS user) stores null operator fields', async () => {
    const { svc, prisma } = makeService();
    await svc.record({ module: 'auth', type: 'login', status: 'failed' });
    expect(prisma.systemLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operatorId: null,
        operator: null,
        oid: null,
        detail: null,
        resources: undefined, // no snapshot → no nested create
      }),
    });
  });

  it('an explicit entry oid wins over the ALS user oid', async () => {
    const { svc, prisma } = makeService();
    await withUser({ id: 7, account: 'alice', oid: 1 }, () =>
      svc.record({ module: 'user', type: 'update', status: 'success', oid: 2 }),
    );
    expect(prisma.systemLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ oid: 2 }),
    });
  });

  it('an empty resources array stores no nested create', async () => {
    const { svc, prisma } = makeService();
    await svc.record({
      module: 'user',
      type: 'logout',
      status: 'success',
      resources: [],
    });
    expect(prisma.systemLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ resources: undefined }),
    });
  });

  it('never breaks the request flow when the write fails (logs + swallows)', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { svc, prisma } = makeService();
    prisma.systemLog.create.mockRejectedValue(new Error('db gone'));
    await expect(
      svc.record({ module: 'auth', type: 'login', status: 'success' }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record audit log: db gone'),
    );
    errorSpy.mockRestore();
  });
});

describe('AuditService.page (read side)', () => {
  it('runs count + findMany in one RepeatableRead transaction, paging desc', async () => {
    const { svc, prisma } = makeService();
    prisma.systemLog.count.mockResolvedValue(31);
    prisma.systemLog.findMany.mockResolvedValue([logRow()]);
    const result = await svc.page(2, 10, {});
    expect(result.total_count).toBe(31);
    expect(result.data).toHaveLength(1);
    expect(prisma.systemLog.count).toHaveBeenCalledWith({ where: {} });
    expect(prisma.systemLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 10, // (2 - 1) * 10
      take: 10,
      include: { resources: { select: { name: true } } },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      [expect.any(Promise), expect.any(Promise)],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  });

  it('maps rows to the snake wire shape, resolving oid names in one batch', async () => {
    const { svc, prisma } = makeService();
    prisma.systemLog.count.mockResolvedValue(2);
    prisma.systemLog.findMany.mockResolvedValue([
      logRow(),
      logRow({
        id: 2,
        oid: 99, // unknown workspace → '-1'
        status: 'fail', // legacy value → normalized 'failed'
        operator: null,
        oid2: undefined,
        resources: [],
      } as Partial<AuditLogRow>),
      logRow({ id: 3, oid: null, ipAddress: null }),
    ]);
    prisma.workspace.findMany.mockResolvedValue([{ id: 1, name: 'Main WS' }]);
    const result = await svc.page(1, 10, {});
    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 99] } }, // distinct non-null oids only
      select: { id: true, name: true },
    });
    expect(result.data[0]).toMatchObject({
      id: '1',
      operation_type_name: 'Create',
      operation_detail_info: 'created datasource ds1',
      user_name: 'alice',
      resource_name: 'ds1',
      operation_status: 'success',
      operation_status_name: 'Success',
      ip_address: '127.0.0.1',
      create_time: CREATED_AT.getTime(),
      oid_name: 'Main WS',
      oid: '1',
    });
    expect(result.data[1]).toMatchObject({
      operation_status: 'failed', // legacy 'fail' normalized
      user_name: '',
      oid_name: '-1',
    });
    expect(result.data[2]).toMatchObject({ oid: '', oid_name: '-1' });
  });

  it('skips the workspace lookup entirely when no row carries an oid', async () => {
    const { svc, prisma } = makeService();
    prisma.systemLog.findMany.mockResolvedValue([
      logRow({ oid: null }),
      logRow({ oid: null }),
    ]);
    await svc.page(1, 10, {});
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'name keyword',
      { name: 'bob' },
      {
        OR: [
          { detail: { contains: 'bob', mode: 'insensitive' } },
          { operator: { contains: 'bob', mode: 'insensitive' } },
          {
            resources: {
              some: { name: { contains: 'bob', mode: 'insensitive' } },
            },
          },
        ],
      },
    ],
    [
      'opt_type_list',
      { opt_type_list: 'login__logout' },
      { type: { in: ['login', 'logout'] } },
    ],
    ['uid_list', { uid_list: '1__7' }, { operatorId: { in: [1, 7] } }],
    ['oid_list', { oid_list: '2__3' }, { oid: { in: [2, 3] } }],
    [
      'log_status',
      { log_status: 'success__failed' },
      { status: { in: ['success', 'failed'] } },
    ],
    [
      'time_range',
      { time_range: '1000__2000' },
      {
        createdAt: { gte: new Date(1000), lte: new Date(2000) },
      },
    ],
  ] as Array<[string, AuditLogQuery, Record<string, unknown>]>)(
    'filter %s → where %j',
    async (_label, query, expected) => {
      const { svc, prisma } = makeService();
      await svc.page(1, 10, query);
      expect(prisma.systemLog.count).toHaveBeenCalledWith({
        where: expected,
      });
      expect(prisma.systemLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expected }),
      );
    },
  );

  it('ignores malformed time ranges instead of building a broken where', async () => {
    const { svc, prisma } = makeService();
    await svc.page(1, 10, { time_range: '1000' }); // not two parts
    await svc.page(1, 10, { time_range: 'a__b' }); // non-numeric
    await svc.page(1, 10, { time_range: '1__2__3' }); // too many parts
    for (const call of prisma.systemLog.count.mock.calls) {
      expect(call[0]).toEqual({ where: {} });
    }
  });

  it('combines every filter into one where', async () => {
    const { svc, prisma } = makeService();
    await svc.page(1, 10, {
      name: 'ds',
      opt_type_list: 'create',
      uid_list: '7',
      oid_list: '1',
      log_status: 'success',
      time_range: '0__9999',
    });
    expect(prisma.systemLog.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { detail: { contains: 'ds', mode: 'insensitive' } },
          { operator: { contains: 'ds', mode: 'insensitive' } },
          {
            resources: {
              some: { name: { contains: 'ds', mode: 'insensitive' } },
            },
          },
        ],
        type: { in: ['create'] },
        operatorId: { in: [7] },
        oid: { in: [1] },
        status: { in: ['success'] },
        createdAt: { gte: new Date(0), lte: new Date(9999) },
      },
    });
  });
});

describe('AuditService.getOptions', () => {
  it('derives the operation-type options from the enum (lowercase id, capitalized name)', () => {
    const { svc } = makeService();
    const options = svc.getOptions();
    expect(options).toHaveLength(Object.values(OperationType).length);
    expect(options[0]).toEqual({ id: 'login', name: 'Login' });
    expect(options.map((o) => o.id)).toContain('disable');
  });
});

describe('AuditService.export', () => {
  it('builds a real xlsx of the FULL filtered set and re-parses it', async () => {
    const { svc, prisma } = makeService();
    prisma.systemLog.findMany.mockResolvedValue([
      logRow({ id: 1 }),
      logRow({
        id: 2,
        type: 'delete',
        status: 'failed',
        errorMessage: 'boom',
        createdAt: new Date('2026-02-03T04:05:06Z'),
      }),
    ]);
    prisma.workspace.findMany.mockResolvedValue([{ id: 1, name: 'Main WS' }]);
    const buffer = await svc.export({ opt_type_list: 'create__delete' });
    // the export carries the filter but no pagination
    expect(prisma.systemLog.findMany).toHaveBeenCalledWith({
      where: { type: { in: ['create', 'delete'] } },
      orderBy: { createdAt: 'desc' },
      include: { resources: { select: { name: true } } },
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('SystemLog');
    expect(ws).toBeDefined();
    expect(ws.rowCount).toBe(3); // header + 2 data rows
    const header = ws.getRow(1).values as unknown[];
    // headers come from the i18n keys (+ the one hardcoded Chinese column)
    expect(header).toContain('Operation type');
    expect(header).toContain('Operation detail');
    expect(header).toContain('User');
    expect(header).toContain('Workspace');
    expect(header).toContain('Status');
    expect(header).toContain('IP地址');
    expect(header).toContain('Time');

    // Column keys don't survive the xlsx round-trip — assert by column index
    // in the service's ws.columns order (type, detail, user, ws, status, ip, time).
    const first = ws.getRow(2);
    expect(first.getCell(1).value).toBe('Create');
    expect(first.getCell(2).value).toBe('created datasource ds1');
    expect(first.getCell(3).value).toBe('alice');
    expect(first.getCell(4).value).toBe('Main WS');
    expect(first.getCell(5).value).toBe('Success');
    expect(first.getCell(6).value).toBe('127.0.0.1');
    expect(first.getCell(7).value).toBe(
      '2026-01-02T03:04:05.000Z', // epoch-ms rendered as ISO for the sheet
    );
    const second = ws.getRow(3);
    expect(second.getCell(1).value).toBe('Delete');
    expect(second.getCell(5).value).toBe('Failed');
  });
});
