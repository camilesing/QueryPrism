// Dynamic cron registration tests (MetaDataImprove M5): enabled sources get a
// job, invalid crons are skipped, refresh/remove keep the registry in sync.
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { MetadataSyncSchedulerService } from './metadata-sync-scheduler.service';

function makeScheduler() {
  const prisma = {
    metadataSyncSource: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
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
      { id: 1, cron: '0 3 * * *' },
      { id: 2, cron: 'not-a-cron' },
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
      });
      await m.scheduler.refresh(7);
      expect(m.scheduler.hasJob(7)).toBe(true);

      m.prisma.metadataSyncSource.findUnique.mockResolvedValue({
        enabled: false,
        cron: '*/5 * * * *',
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
