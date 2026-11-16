// Dynamic cron registration tests (MetaDataImprove M5): enabled sources get a
// job, invalid crons are skipped, refresh/remove keep the registry in sync.
import { Logger } from '@nestjs/common';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { MetadataSyncSchedulerService } from './metadata-sync-scheduler.service';

function makeScheduler() {
  const prisma = {
    metadataSyncSource: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    workspace: {
      findMany: jest.fn().mockResolvedValue([{ id: 1 }]),
      findUnique: jest.fn().mockResolvedValue({ archivedAt: null }),
    },
  };
  const runner = { run: jest.fn().mockResolvedValue({}) };
  const scheduler = new MetadataSyncSchedulerService(
    prisma as never,
    runner as never,
  );
  return { scheduler, prisma, runner };
}

describe('MetadataSyncSchedulerService', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('registers enabled sources and skips invalid crons', async () => {
    const m = makeScheduler();
    m.prisma.metadataSyncSource.findMany.mockResolvedValue([
      { id: 1, oid: 1, cron: '0 3 * * *' },
      { id: 2, oid: 1, cron: 'not-a-cron' },
    ]);

    await m.scheduler.onApplicationBootstrap();

    expect(m.scheduler.hasJob(1)).toBe(true);
    expect(m.scheduler.hasJob(2)).toBe(false);
    m.scheduler.onApplicationShutdown();
    expect(m.scheduler.hasJob(1)).toBe(false);
  });

  it('refresh adds a job for an enabled source and removes it when disabled', async () => {
    const m = makeScheduler();
    try {
      m.prisma.metadataSyncSource.findUnique.mockResolvedValue({
        enabled: true,
        cron: '*/5 * * * *',
        oid: 1,
      });
      await m.scheduler.refresh(7);
      expect(m.scheduler.hasJob(7)).toBe(true);

      m.prisma.metadataSyncSource.findUnique.mockResolvedValue({
        enabled: false,
        cron: '*/5 * * * *',
        oid: 1,
      });
      await m.scheduler.refresh(7);
      expect(m.scheduler.hasJob(7)).toBe(false);
    } finally {
      m.scheduler.onApplicationShutdown();
    }
  });

  it('remove drops the registered job', async () => {
    const m = makeScheduler();
    try {
      m.prisma.metadataSyncSource.findUnique.mockResolvedValue({
        enabled: true,
        cron: '0 * * * *',
        oid: 1,
      });
      await m.scheduler.refresh(3);
      expect(m.scheduler.hasJob(3)).toBe(true);
      m.scheduler.remove(3);
      expect(m.scheduler.hasJob(3)).toBe(false);
    } finally {
      m.scheduler.onApplicationShutdown();
    }
  });
});

describe('MetadataSyncSchedulerService residual arms', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('skips source discovery entirely when no active workspaces exist', async () => {
    const m = makeScheduler();
    m.prisma.workspace.findMany.mockResolvedValue([]);
    await m.scheduler.onApplicationBootstrap();
    expect(m.prisma.metadataSyncSource.findMany).not.toHaveBeenCalled();
    expect(m.scheduler.hasJob(1)).toBe(false);
  });

  it('skips sources whose cron is null (defensive against query drift)', async () => {
    const m = makeScheduler();
    m.prisma.metadataSyncSource.findMany.mockResolvedValue([
      { id: 5, oid: 1, cron: null },
    ]);
    await m.scheduler.onApplicationBootstrap();
    expect(m.scheduler.hasJob(5)).toBe(false);
  });

  it('bootstrap survives a database error and logs the Error message', async () => {
    const m = makeScheduler();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      m.prisma.workspace.findMany.mockRejectedValue(
        new Error('relation "MetadataSyncSource" does not exist'),
      );
      await m.scheduler.onApplicationBootstrap();
      expect(warnSpy).toHaveBeenCalledWith(
        'metadata sync scheduler init skipped: relation "MetadataSyncSource" does not exist',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('bootstrap stringifies a non-Error failure reason', async () => {
    const m = makeScheduler();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      m.prisma.workspace.findMany.mockRejectedValue('migrations pending');
      await m.scheduler.onApplicationBootstrap();
      expect(warnSpy).toHaveBeenCalledWith(
        'metadata sync scheduler init skipped: migrations pending',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refresh drops the job when the workspace is missing or archived', async () => {
    const m = makeScheduler();
    try {
      m.prisma.metadataSyncSource.findUnique.mockResolvedValue({
        enabled: true,
        cron: '*/5 * * * *',
        oid: 1,
      });
      m.prisma.workspace.findUnique.mockResolvedValue(null);
      await m.scheduler.refresh(8);
      expect(m.scheduler.hasJob(8)).toBe(false);

      m.prisma.workspace.findUnique.mockResolvedValue({
        archivedAt: new Date('2026-01-01T00:00:00Z'),
      });
      await m.scheduler.refresh(8);
      expect(m.scheduler.hasJob(8)).toBe(false);
    } finally {
      m.scheduler.onApplicationShutdown();
    }
  });

  it('fires scheduled jobs and logs both Error and non-Error run failures', async () => {
    const m = makeScheduler();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    // every-second crons so both jobs fire on the same wall-clock tick
    m.prisma.metadataSyncSource.findMany.mockResolvedValue([
      { id: 11, oid: 1, cron: '* * * * * *' },
      { id: 12, oid: 1, cron: '* * * * * *' },
    ]);
    m.runner.run.mockImplementation((id: number) =>
      id === 11
        ? Promise.reject(new Error('runner exploded'))
        : // Intentionally rejects with a non-Error: the logger must stringify it.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject('plain failure'),
    );
    try {
      await m.scheduler.onApplicationBootstrap();
      await new Promise((r) => setTimeout(r, 1500));
      expect(m.runner.run).toHaveBeenCalledWith(11, 'cron');
      expect(m.runner.run).toHaveBeenCalledWith(12, 'cron');
      expect(errorSpy).toHaveBeenCalledWith(
        'metadata sync #11 cron failed: runner exploded',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'metadata sync #12 cron failed: plain failure',
      );
    } finally {
      m.scheduler.onApplicationShutdown();
      errorSpy.mockRestore();
    }
  }, 10000);
});
