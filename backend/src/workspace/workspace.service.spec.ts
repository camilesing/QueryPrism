// WorkspaceService spec — permanentRemove lifecycle guards (irreversible)
// and the excel_store cleanup the bulk delete must not skip.
import { WorkspaceService } from './workspace.service';
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
