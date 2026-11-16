// WorkspaceService spec — permanentRemove lifecycle guards (irreversible)
// and the excel_store cleanup the bulk delete must not skip.
import { WorkspaceService } from './workspace.service';
import { Prisma } from '@prisma/client';
import { ExcelStoreService } from '../datasource/excel-store.service';
import { encryptFrontendConfig } from '../datasource/frontend-config-crypto';
import { PrismaService } from '../database/prisma.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

function makePrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    workspace: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 2, archivedAt: new Date() }),
      delete: jest.fn(),
    },
    user: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    chat: { deleteMany: jest.fn() },
    chatRecord: { deleteMany: jest.fn() },
    datasource: { deleteMany: jest.fn() },
    terminology: { deleteMany: jest.fn() },
    dataTraining: { deleteMany: jest.fn() },
    coreDashboard: { deleteMany: jest.fn() },
    assistant: { deleteMany: jest.fn() },
    mcpIntegration: { deleteMany: jest.fn() },
    customPrompt: { deleteMany: jest.fn() },
    dsRules: { deleteMany: jest.fn() },
    systemLog: { updateMany: jest.fn() },
    userWs: { deleteMany: jest.fn() },
  };
  const prisma = {
    ...tx,
    datasource: {
      ...tx.datasource,
      findMany: jest.fn().mockResolvedValue([]),
    },
    table: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
    ...overrides,
  };
  return { prisma, tx };
}

function makeService(prisma: unknown) {
  const excelStore = { dropTables: jest.fn().mockResolvedValue(undefined) };
  const service = new WorkspaceService(
    prisma as PrismaService,
    excelStore as unknown as ExcelStoreService,
  );
  return { service, excelStore };
}

describe('WorkspaceService.permanentRemove', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('refuses the default workspace', async () => {
    const { prisma, tx } = makePrisma();
    const { service, excelStore } = makeService(prisma);
    await expect(service.permanentRemove(1)).rejects.toThrow(
      'The default workspace cannot be deleted',
    );
    // guards fire before ANY write
    expect(tx.workspace.delete).not.toHaveBeenCalled();
    expect(tx.userWs.deleteMany).not.toHaveBeenCalled();
    expect(excelStore.dropTables).not.toHaveBeenCalled();
  });

  it('refuses a workspace that is not archived (two-step safety)', async () => {
    const { prisma, tx } = makePrisma();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 2,
      archivedAt: null,
    });
    const { service, excelStore } = makeService(prisma);
    await expect(service.permanentRemove(2)).rejects.toThrow(
      'Archive the workspace before deleting it permanently',
    );
    expect(tx.workspace.delete).not.toHaveBeenCalled();
    expect(excelStore.dropTables).not.toHaveBeenCalled();
  });

  it('drops the workspace excel datasources physical sheets after the delete', async () => {
    const { prisma } = makePrisma();
    const events: string[] = [];
    prisma.$transaction.mockImplementation(
      async (fn: (client: unknown) => Promise<unknown>) => {
        const out = await fn(prisma);
        events.push('tx-committed');
        return out;
      },
    );
    // one readable config, one unreadable config with persisted Table rows
    prisma.datasource.findMany.mockResolvedValue([
      {
        id: 11,
        type: 'excel',
        configuration: encryptFrontendConfig({
          sheets: [{ tableName: 'sheet_a' }, { tableName: 'sheet_b' }],
        }),
      },
      { id: 12, type: 'excel', configuration: 'tampered' },
      { id: 13, type: 'mysql', configuration: 'irrelevant' },
    ]);
    prisma.table.findMany.mockResolvedValue([
      { tableName: 'sheet_c' },
      { tableName: 'sheet_a' }, // deduplicated against the config
    ]);
    const { service, excelStore } = makeService(prisma);
    excelStore.dropTables.mockImplementation(() => {
      events.push('sheets-dropped');
      return Promise.resolve();
    });

    await expect(service.permanentRemove(2)).resolves.toEqual({
      success: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // union of config sheets + synced Table rows, deduplicated
    expect(excelStore.dropTables).toHaveBeenCalledWith([
      'sheet_a',
      'sheet_b',
      'sheet_c',
    ]);
    // and only AFTER the row transaction committed
    expect(events).toEqual(['tx-committed', 'sheets-dropped']);
  });
});

// ─── appended coverage: CRUD/lifecycle, uws pager/option, uws mutations ────
// Same makePrisma/makeService pattern as the permanentRemove suite above,
// extended with every model the member-management paths touch. The single
// client doubles as the tx client (interactive $transaction) and answers the
// array form (pager's [count, findMany]).

function makeWsPrisma(overrides: Record<string, unknown> = {}) {
  const prisma = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 10, name: 'ws' }),
      update: jest.fn().mockResolvedValue({ id: 2, name: 'ws' }),
      delete: jest.fn().mockResolvedValue({ id: 2 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn(),
    },
    userWs: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chat: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    chatRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    datasource: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    terminology: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    dataTraining: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    coreDashboard: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    assistant: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mcpIntegration: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    customPrompt: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    dsRules: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    systemLog: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    table: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    ...overrides,
  };
  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return (arg as (tx: unknown) => unknown)(prisma);
  });
  return prisma;
}

function makeWsService(prisma: unknown) {
  const excelStore = { dropTables: jest.fn().mockResolvedValue(undefined) };
  const service = new WorkspaceService(
    prisma as PrismaService,
    excelStore as unknown as ExcelStoreService,
  );
  return { service, excelStore };
}

function makeWsUser(overrides: Record<string, unknown> = {}) {
  return { id: 5, account: 'ada', oid: 3, language: 'en', ...overrides };
}

describe('WorkspaceService.findAll / findArchived / findOne', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('findAll lists active workspaces with member counts', async () => {
    const prisma = makeWsPrisma();
    const rows = [{ id: 2, name: 'sales', _count: { users: 4 } }];
    prisma.workspace.findMany.mockResolvedValue(rows);
    const { service } = makeWsService(prisma);
    await expect(service.findAll()).resolves.toBe(rows);
    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true } } },
    });
  });

  it('findArchived lists soft-deleted workspaces, archive date first', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findMany.mockResolvedValue([]);
    const { service } = makeWsService(prisma);
    await expect(service.findArchived()).resolves.toEqual([]);
    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      include: { _count: { select: { users: true } } },
    });
  });

  it('findOne returns the row with its member count', async () => {
    const prisma = makeWsPrisma();
    const row = { id: 2, name: 'sales', _count: { users: 4 } };
    prisma.workspace.findUnique.mockResolvedValue(row);
    const { service } = makeWsService(prisma);
    await expect(service.findOne(2)).resolves.toBe(row);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 2 },
      include: { _count: { select: { users: true } } },
    });
  });

  it('findOne throws NotFound for a missing id', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.findOne(3)).rejects.toThrow('Workspace #3 not found');
  });
});

describe('WorkspaceService.create', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('rejects a blank/whitespace name', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.create({ name: '   ' })).rejects.toThrow(
      'Workspace name must not be empty',
    );
    await expect(service.create({ name: undefined })).rejects.toThrow(
      'Workspace name must not be empty',
    );
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('creates a trimmed name without a description column by default', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.create.mockResolvedValue({ id: 10, name: 'sales' });
    const { service } = makeWsService(prisma);
    await expect(service.create({ name: '  sales  ' })).resolves.toEqual({
      id: 10,
      name: 'sales',
    });
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: { name: 'sales' },
      include: { _count: { select: { users: true } } },
    });
  });

  it('passes an explicit description through (null included)', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await service.create({ name: 'ops', description: null });
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: { name: 'ops', description: null },
      include: { _count: { select: { users: true } } },
    });
  });

  it('maps a P2002 unique violation to a friendly BadRequest', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const { service } = makeWsService(prisma);
    await expect(service.create({ name: 'sales' })).rejects.toThrow(
      'Workspace name already exists',
    );
  });

  it('rethrows non-duplicate errors untouched', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.create.mockRejectedValue(new Error('db down'));
    const { service } = makeWsService(prisma);
    await expect(service.create({ name: 'sales' })).rejects.toThrow('db down');
  });
});

describe('WorkspaceService.update', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('rejects a blank name before any DB round trip', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.update({ id: 2, name: '  ' })).rejects.toThrow(
      'Workspace name must not be empty',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws NotFound inside the transaction for a missing workspace', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.update({ id: 3, name: 'new' })).rejects.toThrow(
      'Workspace #3 not found',
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('trims the name and updates the description together', async () => {
    const prisma = makeWsPrisma();
    const row = { id: 2, name: 'sales', _count: { users: 3 } };
    prisma.workspace.findUnique.mockResolvedValue(row);
    prisma.workspace.update.mockResolvedValue(row);
    const { service } = makeWsService(prisma);
    await expect(
      service.update({ id: 2, name: '  sales  ', description: 'revenue' }),
    ).resolves.toBe(row);
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { name: 'sales', description: 'revenue' },
      include: { _count: { select: { users: true } } },
    });
  });

  it('updates the description alone when the name is omitted', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2 });
    const { service } = makeWsService(prisma);
    await service.update({ id: 2, description: 'd2' });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { description: 'd2' },
      include: { _count: { select: { users: true } } },
    });
  });

  it('maps a P2002 on update to a friendly BadRequest', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2 });
    prisma.workspace.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const { service } = makeWsService(prisma);
    await expect(service.update({ id: 2, name: 'dup' })).rejects.toThrow(
      'Workspace name already exists',
    );
  });

  it('rethrows non-duplicate update errors untouched', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2 });
    prisma.workspace.update.mockRejectedValue(new Error('db down'));
    const { service } = makeWsService(prisma);
    await expect(service.update({ id: 2, name: 'x' })).rejects.toThrow(
      'db down',
    );
  });
});

describe('WorkspaceService.archive', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('throws NotFound for a missing workspace', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.archive(2)).rejects.toThrow('Workspace #2 not found');
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('refuses the default workspace (id 1)', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 1 });
    const { service } = makeWsService(prisma);
    await expect(service.archive(1)).rejects.toThrow(
      'The default workspace cannot be deleted',
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses an already-archived workspace', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 2,
      archivedAt: new Date(),
    });
    const { service } = makeWsService(prisma);
    await expect(service.archive(2)).rejects.toThrow(
      'Workspace has been archived',
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('archives and relocates every user parked on the workspace', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2, archivedAt: null });
    prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 5 }, { id: 6 }]);
    // per-user candidate lookup, in user order: admin(1), member(5), member(6)
    prisma.userWs.findFirst
      .mockResolvedValueOnce({ oid: 9 }) // admin still lands on fallback 1
      .mockResolvedValueOnce({ oid: 8 })
      .mockResolvedValueOnce(null);
    const { service } = makeWsService(prisma);

    await expect(service.archive(2)).resolves.toEqual({ success: true });

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { archivedAt: expect.any(Date) },
    });
    expect(prisma.userWs.findFirst).toHaveBeenCalledWith({
      where: { uid: 5, oid: { not: 2 }, workspace: { archivedAt: null } },
      orderBy: { oid: 'asc' },
      select: { oid: true },
    });
    const moves = (
      prisma.user.update.mock.calls as Array<
        [{ where: { id: number }; data: { oid: number } }]
      >
    ).map(([c]) => [c.where.id, c.data.oid]);
    expect(moves).toEqual([
      [1, 1], // system admin → default workspace, never stranded
      [5, 8], // first remaining active membership
      [6, 0], // no membership left → 0
    ]);
  });
});

describe('WorkspaceService.restore', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('throws NotFound for a missing workspace', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(service.restore(2)).rejects.toThrow('Workspace #2 not found');
  });

  it('refuses to restore an active workspace', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2, archivedAt: null });
    const { service } = makeWsService(prisma);
    await expect(service.restore(2)).rejects.toThrow(
      'Workspace is not archived',
    );
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('un-archives and re-homes users whose oid was reset to 0', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 2,
      archivedAt: new Date(),
    });
    const { service } = makeWsService(prisma);
    await expect(service.restore(2)).resolves.toEqual({ success: true });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { archivedAt: null },
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { oid: 0, userWorkspaces: { some: { oid: 2 } } },
      data: { oid: 2 },
    });
  });
});

describe('WorkspaceService.uwsPager', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it("admin + oid: lists that workspace's bindings, weight from the binding", async () => {
    const prisma = makeWsPrisma();
    const joinedAt = new Date('2024-03-01T00:00:00Z');
    prisma.userWs.count.mockResolvedValue(1);
    prisma.userWs.findMany.mockResolvedValue([
      {
        weight: 1,
        createdAt: joinedAt,
        user: {
          id: 5,
          account: 'bob',
          name: 'Bob',
          email: 'b@x.com',
          status: 1,
          createdAt: joinedAt,
        },
      },
    ]);
    const { service } = makeWsService(prisma);

    const out = await service.uwsPager(2, 15, makeWsUser({ id: 1 }), 2, 'bob');

    expect(out.total).toBe(1);
    expect(out.items).toEqual([
      {
        id: 5, // flattened uid — frontend uses row.id for uwsDelete
        name: 'Bob',
        account: 'bob',
        status: 1,
        email: 'b@x.com',
        weight: 1,
        createdAt: joinedAt, // binding createdAt, not user createdAt
      },
    ]);
    const expectedFilter = {
      OR: [
        { account: { contains: 'bob', mode: 'insensitive' } },
        { name: { contains: 'bob', mode: 'insensitive' } },
        { email: { contains: 'bob', mode: 'insensitive' } },
      ],
    };
    expect(prisma.userWs.count).toHaveBeenCalledWith({
      where: { oid: 2, user: expectedFilter },
    });
    expect(prisma.userWs.findMany).toHaveBeenCalledWith({
      where: { oid: 2, user: expectedFilter },
      include: {
        user: {
          select: {
            id: true,
            account: true,
            name: true,
            email: true,
            status: true,
            createdAt: true,
          },
        },
      },
      skip: 15, // (page 2 - 1) * 15
      take: 15,
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('admin without oid: system-wide list, weight = max binding', async () => {
    const prisma = makeWsPrisma();
    prisma.user.count.mockResolvedValue(3);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 5,
        account: 'a',
        name: 'A',
        email: null,
        status: 1,
        createdAt: new Date(),
        userWorkspaces: [{ weight: 1 }, { weight: 0 }],
      },
      {
        id: 6,
        account: 'b',
        name: 'B',
        email: null,
        status: 1,
        createdAt: new Date(),
        userWorkspaces: [],
      },
      {
        id: 7,
        account: 'c',
        name: 'C',
        email: null,
        status: 1,
        createdAt: new Date(),
        userWorkspaces: [{ weight: 0 }],
      },
    ]);
    const { service } = makeWsService(prisma);

    const out = await service.uwsPager(
      1,
      20,
      makeWsUser({ id: 1 }),
      undefined,
      '  ',
    );

    expect(out.total).toBe(3);
    expect(
      out.items.map((i: { id: number; weight: number }) => [i.id, i.weight]),
    ).toEqual([
      [5, 1], // max across bindings
      [6, 0], // no bindings at all → Math.max(0) floor
      [7, 0],
    ]);
    // whitespace-only keyword is dropped → no OR filter
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { userWorkspaces: { some: {} } },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userWorkspaces: { some: {} } },
        skip: 0,
        take: 20,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('non-admin: forced to the current workspace, oid param optional', async () => {
    const prisma = makeWsPrisma();
    prisma.userWs.count.mockResolvedValue(0);
    prisma.userWs.findMany.mockResolvedValue([]);
    const { service } = makeWsService(prisma);

    const out = await service.uwsPager(1, 10, makeWsUser({ id: 5, oid: 3 }));

    expect(out).toEqual({ items: [], total: 0 });
    expect(prisma.userWs.count).toHaveBeenCalledWith({
      where: { oid: 3, user: {} },
    });
    expect(prisma.user.count).not.toHaveBeenCalled(); // never the system-wide path
  });

  it('non-admin: a foreign oid is rejected before any query', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsPager(1, 10, makeWsUser({ id: 5, oid: 3 }), 9),
    ).rejects.toThrow('Only the current workspace can be administered');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.uwsOptionPager', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('lists unbound users, excluding current members, with keyword filter', async () => {
    const prisma = makeWsPrisma();
    prisma.userWs.findMany.mockResolvedValue([{ uid: 5 }, { uid: 6 }]);
    prisma.user.count.mockResolvedValue(1);
    const candidate = {
      id: 9,
      account: 'carol',
      name: 'Carol',
      email: 'c@x.com',
      status: 1,
      createdAt: new Date('2024-04-01T00:00:00Z'),
    };
    prisma.user.findMany.mockResolvedValue([candidate]);
    const { service } = makeWsService(prisma);

    const out = await service.uwsOptionPager(
      1,
      10,
      makeWsUser({ id: 1 }),
      2,
      'car',
    );

    expect(out).toEqual({ items: [candidate], total: 1 });
    expect(prisma.userWs.findMany).toHaveBeenCalledWith({
      where: { oid: 2 },
      select: { uid: true },
    });
    const where = {
      id: { notIn: [5, 6] },
      OR: [
        { account: { contains: 'car', mode: 'insensitive' } },
        { name: { contains: 'car', mode: 'insensitive' } },
        { email: { contains: 'car', mode: 'insensitive' } },
      ],
    };
    expect(prisma.user.count).toHaveBeenCalledWith({ where });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where,
      select: {
        id: true,
        account: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
      },
      skip: 0,
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('non-admin: defaults to their own workspace when the ws has no bindings', async () => {
    const prisma = makeWsPrisma();
    prisma.userWs.findMany.mockResolvedValue([]); // nobody bound → notIn []
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    const { service } = makeWsService(prisma);
    await service.uwsOptionPager(2, 5, makeWsUser({ id: 5, oid: 3 }), 3);
    expect(prisma.userWs.findMany).toHaveBeenCalledWith({
      where: { oid: 3 },
      select: { uid: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { notIn: [] } },
        skip: 5,
        take: 5,
      }),
    );
  });
});

describe('WorkspaceService.uwsOption', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('numeric keywords ALSO match by exact user id', async () => {
    const prisma = makeWsPrisma();
    const hit = { id: 42, account: 'ada', name: 'Ada', email: null, status: 1 };
    prisma.user.findFirst.mockResolvedValue(hit);
    const { service } = makeWsService(prisma);
    await expect(service.uwsOption('42')).resolves.toBe(hit);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { account: { contains: '42', mode: 'insensitive' } },
          { name: { contains: '42', mode: 'insensitive' } },
          { email: { contains: '42', mode: 'insensitive' } },
          { id: 42 },
        ],
      },
      select: {
        id: true,
        account: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
      },
    });
  });

  it('non-numeric keywords never inject an id filter (blank included)', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await service.uwsOption('bob');
    await service.uwsOption('');
    for (const call of prisma.user.findFirst.mock.calls as unknown as Array<
      [{ where: { OR: unknown[] } }]
    >) {
      expect(call[0].where.OR).toHaveLength(3); // account/name/email only
    }
  });
});

describe('WorkspaceService.uwsCreate', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('returns success for an empty uid_list without opening a transaction', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsCreate({ uid_list: [] }, makeWsUser({ id: 1 })),
    ).resolves.toEqual({ success: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('admin: creates missing bindings, updates weights, re-homes oid-0 users', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findFirst.mockResolvedValue({ id: 2 });
    prisma.userWs.findMany.mockResolvedValue([{ uid: 5 }]); // 5 already bound
    const { service } = makeWsService(prisma);

    await expect(
      service.uwsCreate(
        { uid_list: [5, 6], oid: 2, weight: 1 },
        makeWsUser({ id: 1 }),
      ),
    ).resolves.toEqual({ success: true });

    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: 2, archivedAt: null },
      select: { id: true },
    });
    expect(prisma.userWs.createMany).toHaveBeenCalledWith({
      data: [{ uid: 6, oid: 2, weight: 1 }],
      skipDuplicates: true,
    });
    expect(prisma.userWs.updateMany).toHaveBeenCalledWith({
      where: { oid: 2, uid: { in: [5] } },
      data: { weight: 1 },
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 6] }, oid: 0 },
      data: { oid: 2 },
    });
  });

  it('admin: rejects an invalid weight (must be 0 or 1)', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsCreate(
        { uid_list: [5], oid: 2, weight: 2 },
        makeWsUser({ id: 1 }),
      ),
    ).rejects.toThrow('Member role must be 0 or 1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('admin: rejects an unknown/archived target workspace', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findFirst.mockResolvedValue(null);
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsCreate({ uid_list: [5], oid: 9 }, makeWsUser({ id: 1 })),
    ).rejects.toThrow('Workspace #9 does not exist or has been archived');
    expect(prisma.userWs.createMany).not.toHaveBeenCalled();
  });

  it('admin: defaults oid/weight from the request when omitted', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findFirst.mockResolvedValue({ id: 1 });
    const { service } = makeWsService(prisma);
    await service.uwsCreate({ uid_list: [6] }, makeWsUser({ id: 1, oid: 1 }));
    expect(prisma.userWs.createMany).toHaveBeenCalledWith({
      data: [{ uid: 6, oid: 1, weight: 0 }],
      skipDuplicates: true,
    });
  });

  it('ws admin: weight forced to 0 and existing admins never demoted', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findFirst.mockResolvedValue({ id: 3 });
    prisma.userWs.findMany.mockResolvedValue([{ uid: 5 }]); // 5 already bound
    const { service } = makeWsService(prisma);

    await service.uwsCreate(
      { uid_list: [5, 6], oid: 3, weight: 1 }, // weight 1 request is IGNORED
      makeWsUser({ id: 9, oid: 3 }),
    );

    expect(prisma.userWs.createMany).toHaveBeenCalledWith({
      data: [{ uid: 6, oid: 3, weight: 0 }],
      skipDuplicates: true,
    });
    expect(prisma.userWs.updateMany).not.toHaveBeenCalled(); // no demotion path
  });

  it('ws admin: a foreign oid is rejected before any query', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsCreate(
        { uid_list: [6], oid: 9 },
        makeWsUser({ id: 5, oid: 3 }),
      ),
    ).rejects.toThrow('Only the current workspace can be administered');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.uwsUpdate', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('rejects an invalid weight', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsUpdate({ uid: 5, oid: 2, weight: 7 }),
    ).rejects.toThrow('Member role must be 0 or 1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown workspace', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsUpdate({ uid: 5, oid: 3, weight: 1 }),
    ).rejects.toThrow('Workspace #3 not found');
    expect(prisma.userWs.upsert).not.toHaveBeenCalled();
  });

  it('upserts the binding (create OR promote in one call)', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue({ id: 2 });
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsUpdate({ uid: 5, oid: 2, weight: 1 }),
    ).resolves.toEqual({ success: true });
    expect(prisma.userWs.upsert).toHaveBeenCalledWith({
      where: { uid_oid: { uid: 5, oid: 2 } },
      create: { uid: 5, oid: 2, weight: 1 },
      update: { weight: 1 },
    });
  });
});

describe('WorkspaceService.uwsDelete', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('returns success for an empty uid_list without opening a transaction', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsDelete({ uid_list: [] }, makeWsUser({ id: 1 })),
    ).resolves.toEqual({ success: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('admin with oid: removes the bindings and reconciles currents', async () => {
    const prisma = makeWsPrisma();
    // users by id: 1 admin (skipped), 5 → candidate 7, 6 missing, 7 still bound,
    // 8 → no candidate (0), 9 parked on oid 0 (skipped)
    prisma.user.findUnique.mockImplementation(((args: {
      where: { id: number };
    }) => {
      const byId: Record<number, { oid: number } | null> = {
        1: { oid: 2 },
        5: { oid: 2 },
        6: null,
        7: { oid: 2 },
        8: { oid: 2 },
        9: { oid: 0 },
      };
      return Promise.resolve(byId[args.where.id] ?? null);
    }) as never);
    prisma.userWs.findUnique.mockImplementation(((args: {
      where: { uid_oid: { uid: number; oid: number } };
    }) => {
      const key = `${args.where.uid_oid.uid}:${args.where.uid_oid.oid}`;
      return Promise.resolve(
        key === '7:2' ? { uid: 7, oid: 2, weight: 0 } : null,
      );
    }) as never);
    prisma.userWs.findFirst.mockImplementation(((args: {
      where: { uid: number };
    }) => {
      return Promise.resolve(args.where.uid === 5 ? { oid: 7 } : null);
    }) as never);
    const { service } = makeWsService(prisma);

    await expect(
      service.uwsDelete(
        { uid_list: [1, 5, 6, 7, 8, 9], oid: 2 },
        makeWsUser({ id: 1 }),
      ),
    ).resolves.toEqual({ success: true });

    expect(prisma.userWs.deleteMany).toHaveBeenCalledWith({
      where: { oid: 2, uid: { in: [1, 5, 6, 7, 8, 9] } },
    });
    // admin skipped entirely — no read for uid 1
    const readIds = (
      prisma.user.findUnique.mock.calls as unknown as Array<
        [{ where: { id: number } }]
      >
    ).map(([c]) => c.where.id);
    expect(readIds).toEqual([5, 6, 7, 8, 9]);
    // only 5 (→ candidate 7) and 8 (→ 0) are re-pointed
    const moves = (
      prisma.user.update.mock.calls as Array<
        [{ where: { id: number }; data: { oid: number } }]
      >
    ).map(([c]) => [c.where.id, c.data.oid]);
    expect(moves).toEqual([
      [5, 7],
      [8, 0],
    ]);
  });

  it('admin without oid: system-wide removal of every binding', async () => {
    const prisma = makeWsPrisma();
    prisma.user.findUnique.mockResolvedValue(null); // reconcile finds nobody
    const { service } = makeWsService(prisma);
    await service.uwsDelete({ uid_list: [5] }, makeWsUser({ id: 1 }));
    expect(prisma.userWs.deleteMany).toHaveBeenCalledWith({
      where: { uid: { in: [5] } }, // no oid clause
    });
  });

  it('ws admin: refuses to remove another workspace admin', async () => {
    const prisma = makeWsPrisma();
    prisma.userWs.findMany.mockResolvedValue([{ uid: 7 }]); // weight != 0
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsDelete(
        { uid_list: [7], oid: 3 },
        makeWsUser({ id: 5, oid: 3 }),
      ),
    ).rejects.toThrow('The workspace administrator cannot be removed');
    expect(prisma.userWs.deleteMany).not.toHaveBeenCalled();
  });

  it('ws admin: removes ordinary members from the current workspace', async () => {
    const prisma = makeWsPrisma();
    prisma.userWs.findMany.mockResolvedValue([]); // none protected
    prisma.user.findUnique.mockResolvedValue(null); // reconcile no-op
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsDelete({ uid_list: [6] }, makeWsUser({ id: 5, oid: 3 })),
    ).resolves.toEqual({ success: true });
    expect(prisma.userWs.findMany).toHaveBeenCalledWith({
      where: { oid: 3, uid: { in: [6] }, weight: { not: 0 } },
      select: { uid: true },
    });
    expect(prisma.userWs.deleteMany).toHaveBeenCalledWith({
      where: { oid: 3, uid: { in: [6] } },
    });
  });

  it('ws admin: a foreign oid is rejected before any query', async () => {
    const prisma = makeWsPrisma();
    const { service } = makeWsService(prisma);
    await expect(
      service.uwsDelete(
        { uid_list: [6], oid: 9 },
        makeWsUser({ id: 5, oid: 3 }),
      ),
    ).rejects.toThrow('Only the current workspace can be administered');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('WorkspaceService.permanentRemove (missing row)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('throws NotFound before any delete when the workspace does not exist', async () => {
    const prisma = makeWsPrisma();
    prisma.workspace.findUnique.mockResolvedValue(null); // row vanished
    const { service, excelStore } = makeWsService(prisma);
    await expect(service.permanentRemove(2)).rejects.toThrow(
      'Workspace #2 not found',
    );
    expect(prisma.workspace.delete).not.toHaveBeenCalled();
    expect(prisma.chat.deleteMany).not.toHaveBeenCalled();
    expect(excelStore.dropTables).not.toHaveBeenCalled();
  });
});
