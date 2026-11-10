// Dynamic cron registration for metadata sync sources (MetaDataImprove M5).
// Uses the `cron` package directly (CommonJS) rather than @nestjs/schedule's
// ESM-only wrapper, keeping the Jest/ts-jest unit suite runnable.
// Jobs are keyed by source id and refreshed on CRUD.
// KNOWN LIMITATION: this is a single-instance scheduler — every replica
// registers its own copy, so a multi-instance deployment would trigger the
// same source more than once. Add a DB/advisory lock before scaling out.

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { PrismaService } from '../database/prisma.service';
import { isValidCron } from './metadata-sync-policy';
import { MetadataSyncRunnerService } from './metadata-sync-runner.service';

@Injectable()
export class MetadataSyncSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MetadataSyncSchedulerService.name);
  private readonly jobs = new Map<number, CronJob>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: MetadataSyncRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const sources = await this.prisma.metadataSyncSource.findMany({
        where: { enabled: true, cron: { not: null } },
        select: { id: true, cron: true },
      });
      for (const source of sources) {
        if (source.cron) this.add(source.id, source.cron);
      }
    } catch (e) {
      // Startup must not depend on the sync table being migrated yet.
      this.logger.warn(
        `metadata sync scheduler init skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  onApplicationShutdown(): void {
    for (const id of [...this.jobs.keys()]) this.stop(id);
  }

  /** Re-read one source and re-register its job (create/update path). */
  async refresh(id: number): Promise<void> {
    this.remove(id);
    const source = await this.prisma.metadataSyncSource.findUnique({
      where: { id },
      select: { enabled: true, cron: true },
    });
    if (source?.enabled && source.cron) this.add(id, source.cron);
  }

  remove(id: number): void {
    this.stop(id);
  }

  /** Diagnostics/test hook: is a cron job registered for this source? */
  hasJob(id: number): boolean {
    return this.jobs.has(id);
  }

  private add(id: number, cron: string): void {
    if (!isValidCron(cron)) {
      this.logger.warn(
        `metadata sync #${id}: invalid cron "${cron}" — job not scheduled`,
      );
      return;
    }
    this.stop(id);
    const job = new CronJob(cron, () => {
      void this.runner.run(id, 'cron').catch((e: unknown) => {
        this.logger.error(
          `metadata sync #${id} cron failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
    });
    this.jobs.set(id, job);
    job.start();
  }

  private stop(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    void job.stop();
    this.jobs.delete(id);
  }
}
