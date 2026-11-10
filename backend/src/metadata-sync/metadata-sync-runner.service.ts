// Runs one external metadata pull (MetaDataImprove M5): resolve the run-as
// admin, fetch the batch, then reuse the existing /meta import services so
// validation/upsert/versioning stay in ONE place. Manual and cron triggers
// share this path; every attempt is persisted as a MetadataSyncRun.
// Triggers are serialized per source through an in-process FIFO queue: a run
// waits for the ones already queued for the same source instead of failing,
// while different sources still run in parallel.
// KNOWN LIMITATION: the queue lives in this process (single-instance
// assumption, see the scheduler), so a second replica would keep its own
// queue. It is unbounded, but each run is capped by the fetch timeout, so a
// backlog drains rather than growing without bound at normal cron intervals.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MetadataSyncSource } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { ADMIN_UID } from '../auth/admin.guard';
import { tr } from '../common/i18n/translate';
import {
  requestContextStorage,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { SemanticImportService } from '../semantic/semantic-import.service';
import type { SemanticImportRow } from '../semantic/semantic-import.service';
import { MetricImportService } from '../semantic/metric-import.service';
import type {
  MetricImportRow,
  StandardImportRow,
} from '../semantic/metric-import.service';
import { MetadataSyncFetchService } from './metadata-sync-fetch.service';
import {
  SYNC_MAX_FAILURES,
  SYNC_MAX_ROWS,
  syncErrorText,
} from './metadata-sync-policy';

export type SyncTrigger = 'manual' | 'cron';

export interface SyncRunResult {
  run_id: number;
  status: 'success' | 'failed';
  applied: number;
  failed_count: number;
}

export interface ImportOutcome {
  applied: number;
  failed: Array<{ row: string; reason: string }>;
}

@Injectable()
export class MetadataSyncRunnerService {
  private readonly logger = new Logger(MetadataSyncRunnerService.name);
  /** FIFO tail per source id: `run` chains onto the previous promise, so
   *  concurrent triggers execute one after another in arrival order. */
  private readonly tails = new Map<number, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetchService: MetadataSyncFetchService,
    private readonly semanticImport: SemanticImportService,
    private readonly metricImport: MetricImportService,
    private readonly audit: AuditService,
  ) {}

  run(sourceId: number, trigger: SyncTrigger): Promise<SyncRunResult> {
    const previous = this.tails.get(sourceId) ?? Promise.resolve();
    const job = previous
      // A failed run rejects only its own caller: swallowing the previous
      // outcome here keeps the queue alive for the triggers behind it.
      .catch(() => undefined)
      .then(() => this.execute(sourceId, trigger));
    this.tails.set(sourceId, job);
    const clear = (): void => {
      if (this.tails.get(sourceId) === job) this.tails.delete(sourceId);
    };
    // Empty tail when the last queued run settles (fulfilled or rejected).
    void job.then(clear, clear);
    return job;
  }

  private async execute(
    sourceId: number,
    trigger: SyncTrigger,
  ): Promise<SyncRunResult> {
    const source = await this.prisma.metadataSyncSource.findUnique({
      where: { id: sourceId },
    });
    if (!source) {
      throw new NotFoundException(
        tr('metadata-sync.not_found', { id: sourceId }),
      );
    }
    const startedAt = new Date();
    await this.prisma.metadataSyncSource.update({
      where: { id: sourceId },
      data: { lastStatus: 'running', lastRunAt: startedAt, lastError: null },
    });
    let runAs: CurrentUserInfo | null = null;
    try {
      const actor = await this.resolveActor(source);
      runAs = actor;
      const result = await requestContextStorage.run(
        { user: actor, acceptLanguage: actor.language },
        async (): Promise<ImportOutcome> => {
          const rows = await this.fetchService.fetchRows(source);
          if (rows.length > SYNC_MAX_ROWS) {
            throw new BadRequestException(
              tr('metadata-sync.too_many_rows', { max: SYNC_MAX_ROWS }),
            );
          }
          return this.applyRows(source.target, rows);
        },
      );
      // Persist + audit inside the run-as context so the audit row carries the
      // operator/workspace and the run message uses the workspace language.
      return await requestContextStorage.run(
        { user: actor, acceptLanguage: actor.language },
        async (): Promise<SyncRunResult> => {
          // Partial success stays "success" with failedCount > 0; a batch
          // where every row failed is surfaced as a failed run.
          const status: 'success' | 'failed' =
            result.failed.length > 0 && result.applied === 0
              ? 'failed'
              : 'success';
          const allFailedMsg =
            status === 'failed' ? tr('metadata-sync.all_rows_failed') : null;
          const run = await this.prisma.metadataSyncRun.create({
            data: {
              sourceId,
              trigger,
              status,
              applied: result.applied,
              failedCount: result.failed.length,
              failed: result.failed.slice(0, SYNC_MAX_FAILURES),
              error: allFailedMsg,
              startedAt,
              finishedAt: new Date(),
            },
          });
          await this.prisma.metadataSyncSource.update({
            where: { id: sourceId },
            data: { lastStatus: status, lastError: allFailedMsg },
          });
          await this.audit.record({
            module: OperationModule.METADATA_SYNC,
            type: OperationType.SYNC,
            status,
            detail: `metadata sync #${sourceId} (${trigger})`,
            oid: source.oid,
            errorMessage: allFailedMsg,
          });
          return {
            run_id: run.id,
            status,
            applied: result.applied,
            failed_count: result.failed.length,
          };
        },
      );
    } catch (e) {
      const msg = syncErrorText(e);
      this.logger.error(`metadata sync #${sourceId} failed: ${msg}`);
      const recordFailure = async (): Promise<void> => {
        await this.prisma.metadataSyncRun.create({
          data: {
            sourceId,
            trigger,
            status: 'failed',
            error: msg,
            startedAt,
            finishedAt: new Date(),
          },
        });
        await this.prisma.metadataSyncSource.update({
          where: { id: sourceId },
          data: { lastStatus: 'failed', lastError: msg },
        });
        await this.audit.record({
          module: OperationModule.METADATA_SYNC,
          type: OperationType.SYNC,
          status: 'failed',
          detail: `metadata sync #${sourceId} (${trigger})`,
          oid: source.oid,
          errorMessage: msg,
        });
      };
      if (runAs) {
        await requestContextStorage.run(
          { user: runAs, acceptLanguage: runAs.language },
          recordFailure,
        );
      } else {
        await recordFailure();
      }
      // Manual callers get a readable 400; cron callers log it in the
      // scheduler. Never leak auth headers: messages only carry the URL/status
      // produced by the fetch service.
      throw new BadRequestException(msg);
    }
  }

  /** The stored createdBy must still be an enabled workspace admin for the
   *  source's workspace — otherwise the import services would reject the run
   *  halfway. Fail before fetching (loud misconfiguration). */
  private async resolveActor(
    source: MetadataSyncSource,
  ): Promise<CurrentUserInfo> {
    const user = await this.prisma.user.findUnique({
      where: { id: source.createdBy },
      select: {
        id: true,
        account: true,
        language: true,
        status: true,
        userWorkspaces: { select: { oid: true, weight: true } },
      },
    });
    if (!user || user.status !== 1) {
      throw new BadRequestException(tr('metadata-sync.run_as_invalid'));
    }
    const membership = user.userWorkspaces.find((m) => m.oid === source.oid);
    const weight = membership?.weight ?? 0;
    if (user.id !== ADMIN_UID && (!membership || weight === 0)) {
      throw new BadRequestException(tr('metadata-sync.run_as_invalid'));
    }
    return {
      id: user.id,
      account: user.account,
      oid: source.oid,
      language: user.language,
      weight,
    };
  }

  private async applyRows(
    target: string,
    rows: unknown[],
  ): Promise<ImportOutcome> {
    if (target === 'semantic') {
      return this.semanticImport.importJson(rows as SemanticImportRow[]);
    }
    if (target === 'metric') {
      return this.metricImport.importJsonMetrics(rows as MetricImportRow[]);
    }
    if (target === 'standard') {
      return this.metricImport.importJsonStandards(rows as StandardImportRow[]);
    }
    throw new BadRequestException(tr('metadata-sync.invalid_target'));
  }
}
