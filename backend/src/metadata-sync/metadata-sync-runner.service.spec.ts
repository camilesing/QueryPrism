// Runner tests: actor revalidation, target dispatch, run persistence and the
// per-source FIFO queue (MetaDataImprove M5).
import type { MetadataSyncSource } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { RequestContext } from '../common/context/request-context';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { MetadataSyncRunnerService } from './metadata-sync-runner.service';

function source(over: Partial<MetadataSyncSource> = {}): MetadataSyncSource {
  return {
    id: 1,
    oid: 1,
    name: 's',
    kind: 'HTTP_API',
    target: 'semantic',
    endpoint: 'https://meta.example.com/rows',
    httpMethod: 'GET',
    httpBody: null,
    authJson: null,
    mcpTool: null,
    mcpArgs: null,
    cron: null,
    enabled: true,
    createdBy: 1,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeRunner() {
  const prisma = {
    metadataSyncSource: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    metadataSyncRun: {
      create: jest.fn().mockResolvedValue({ id: 77 }),
    },
    user: { findUnique: jest.fn() },
  };
  const fetchService = { fetchRows: jest.fn() };
  const semanticImport = { importJson: jest.fn() };
  const metricImport = {
    importJsonMetrics: jest.fn(),
    importJsonStandards: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const runner = new MetadataSyncRunnerService(
    prisma as never,
    fetchService as never,
    semanticImport as never,
    metricImport as never,
    audit as never,
  );
  return { runner, prisma, fetchService, semanticImport, metricImport, audit };
}

const ADMIN = {
  id: 1,
  account: 'admin',
  language: 'zh-CN',
  status: 1,
  userWorkspaces: [],
};

describe('MetadataSyncRunnerService', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('imports the fetched rows through the target service', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    m.fetchService.fetchRows.mockResolvedValue([{ table_name: 'users' }]);
    m.semanticImport.importJson.mockResolvedValue({ applied: 1, failed: [] });
    let auditUserId: number | undefined;
    m.audit.record.mockImplementation(() => {
      auditUserId = RequestContext.getUser()?.id;
      return Promise.resolve();
    });

    const result = await m.runner.run(1, 'manual');

    expect(result).toEqual({
      run_id: 77,
      status: 'success',
      applied: 1,
      failed_count: 0,
    });
    expect(m.fetchService.fetchRows).toHaveBeenCalledTimes(1);
    expect(m.semanticImport.importJson).toHaveBeenCalledWith([
      { table_name: 'users' },
    ]);
    expect(m.prisma.metadataSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceId: 1,
          trigger: 'manual',
          status: 'success',
          applied: 1,
          failedCount: 0,
        }),
      }),
    );
    expect(m.prisma.metadataSyncSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastStatus: 'success' }),
      }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        module: OperationModule.METADATA_SYNC,
        type: OperationType.SYNC,
        status: 'success',
      }),
    );
    // The audit write runs inside the run-as context so it can attribute the
    // operator (a cron tick otherwise has no request user).
    expect(auditUserId).toBe(1);
  });

  it('routes metric and standard targets', async () => {
    const metric = makeRunner();
    metric.prisma.metadataSyncSource.findUnique.mockResolvedValue(
      source({ target: 'metric' }),
    );
    metric.prisma.user.findUnique.mockResolvedValue(ADMIN);
    metric.fetchService.fetchRows.mockResolvedValue([{ code: 'm1' }]);
    metric.metricImport.importJsonMetrics.mockResolvedValue({
      applied: 1,
      failed: [],
    });
    await metric.runner.run(1, 'manual');
    expect(metric.metricImport.importJsonMetrics).toHaveBeenCalledWith([
      { code: 'm1' },
    ]);

    const standard = makeRunner();
    standard.prisma.metadataSyncSource.findUnique.mockResolvedValue(
      source({ target: 'standard' }),
    );
    standard.prisma.user.findUnique.mockResolvedValue(ADMIN);
    standard.fetchService.fetchRows.mockResolvedValue([{ code: 's1' }]);
    standard.metricImport.importJsonStandards.mockResolvedValue({
      applied: 1,
      failed: [],
    });
    await standard.runner.run(1, 'manual');
    expect(standard.metricImport.importJsonStandards).toHaveBeenCalledWith([
      { code: 's1' },
    ]);
  });

  it('marks a run failed when every row is rejected', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    m.fetchService.fetchRows.mockResolvedValue([{ bad: true }]);
    m.semanticImport.importJson.mockResolvedValue({
      applied: 0,
      failed: [{ row: 'row1', reason: 'invalid' }],
    });

    const result = await m.runner.run(1, 'cron');

    expect(result.status).toBe('failed');
    expect(result.failed_count).toBe(1);
    expect(m.prisma.metadataSyncSource.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStatus: 'failed',
          lastError: '所有导入行都未通过校验',
        }),
      }),
    );
  });

  it('fails loudly when the run-as user is no longer an admin', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    // A workspace source whose creator is not uid 1 and has no membership.
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(
      source({ createdBy: 9, oid: 2 }),
    );
    m.prisma.user.findUnique.mockResolvedValue({
      id: 9,
      account: 'member',
      language: 'en',
      status: 1,
      userWorkspaces: [],
    });

    await expect(m.runner.run(1, 'manual')).rejects.toThrow(
      'no longer a workspace admin',
    );
    expect(m.fetchService.fetchRows).not.toHaveBeenCalled();
    expect(m.prisma.metadataSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('persists fetch failures on the run and the source', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    m.fetchService.fetchRows.mockRejectedValue(new Error('HTTP 500'));

    await expect(m.runner.run(1, 'manual')).rejects.toThrow('HTTP 500');
    expect(m.prisma.metadataSyncSource.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStatus: 'failed',
          lastError: 'HTTP 500',
        }),
      }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'HTTP 500' }),
    );
  });

  it('queues a second run of the same source behind the first', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    const pending: Array<(rows: unknown[]) => void> = [];
    m.fetchService.fetchRows.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    m.semanticImport.importJson.mockResolvedValue({ applied: 1, failed: [] });

    const first = m.runner.run(1, 'manual');
    // Let the first run reach its fetch await before the second is queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = m.runner.run(1, 'manual');

    // While the first fetch is unresolved, the queued trigger must stay
    // parked. Without the FIFO chain it would reach fetchRows within a few
    // microtasks, so this window is what makes the assertion meaningful.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pending).toHaveLength(1);

    pending[0]([{ table_name: 'first' }]);
    await expect(first).resolves.toMatchObject({ status: 'success' });
    // The queued trigger starts only after the first one settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(2);

    pending[1]([{ table_name: 'second' }]);
    await expect(second).resolves.toMatchObject({ status: 'success' });

    expect(m.semanticImport.importJson).toHaveBeenNthCalledWith(1, [
      { table_name: 'first' },
    ]);
    expect(m.semanticImport.importJson).toHaveBeenNthCalledWith(2, [
      { table_name: 'second' },
    ]);
  });

  it('keeps the queue alive after a failed run', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    m.fetchService.fetchRows
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce([{ table_name: 'ok' }]);
    m.semanticImport.importJson.mockResolvedValue({ applied: 1, failed: [] });

    const first = m.runner.run(1, 'manual');
    const second = m.runner.run(1, 'manual');

    // The failure belongs to its own caller only; the next trigger still runs.
    await expect(first).rejects.toThrow('HTTP 500');
    await expect(second).resolves.toMatchObject({ status: 'success' });
    expect(m.fetchService.fetchRows).toHaveBeenCalledTimes(2);
  });

  it('does not serialize runs of different sources', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockImplementation(
      (args: { where: { id: number } }) =>
        Promise.resolve(source({ id: args.where.id })),
    );
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    const pending: Array<(rows: unknown[]) => void> = [];
    m.fetchService.fetchRows.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    m.semanticImport.importJson.mockResolvedValue({ applied: 0, failed: [] });

    const first = m.runner.run(1, 'manual');
    const second = m.runner.run(2, 'manual');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Separate queues: both sources fetch without waiting for one another.
    expect(m.fetchService.fetchRows).toHaveBeenCalledTimes(2);

    pending[0]([]);
    pending[1]([]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('enforces the 5000-row pull cap before importing', async () => {
    const m = makeRunner();
    m.prisma.metadataSyncSource.findUnique.mockResolvedValue(source());
    m.prisma.user.findUnique.mockResolvedValue(ADMIN);
    m.fetchService.fetchRows.mockResolvedValue(
      Array.from({ length: 5001 }, (_, i) => ({ i })),
    );

    await expect(m.runner.run(1, 'manual')).rejects.toThrow(
      '外部接口返回超过 5000 行',
    );
    expect(m.semanticImport.importJson).not.toHaveBeenCalled();
  });
});
