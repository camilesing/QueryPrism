// RegressionService (MetaDataImprove M6) — the semantic regression suite.
// Standard questions are re-run through the FULL NL2SQL pipeline (so the SQL
// reflects the current semantic layer), then DB-side COUNT/SUM aggregates are
// compared against the stored baseline. Growth beyond tolerance flags the
// case — join fan-out inflates row counts, a dropped filter widens a caliber
// and inflates sums. Neither is visible in code review.
//
// Trigger policy (confirmed): approvals only + manual/API. Direct writes,
// imports and metadata-sync runs do NOT auto-trigger (LLM cost).
//
// Scheduling is in-process (single-instance assumption, same as the
// metadata-sync scheduler): a per-oid FIFO serializes runs, a 30s debounce
// coalesces approval bursts, and approvals arriving while a run is in flight
// simply schedule the next one after it.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, type RegressionCase } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DatasourceService } from '../datasource/datasource.service';
import type { QueryResult } from '../datasource/db-connector/db-connector.interface';
import { ChatService } from '../chat/chat.service';
import { collectPipeline } from '../mcp/pipeline-collector';
import { engineFromDatasourceType } from '../llm/ai-question';
import { AuditService } from '../audit/audit.service';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { ADMIN_UID } from '../auth/admin.guard';
import {
  requestContextStorage,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import {
  RegressionTriggerService,
  type RegressionRunLauncher,
} from './regression-trigger.service';
import {
  buildVerifySql,
  compareCase,
  detectNumericColumns,
  parseVerifyResult,
  sqlTextHash,
  type CaseDelta,
  type RegressionBaseline,
} from './regression-policy';

/** Coalesce a burst of approvals into one run before spending LLM budget. */
const APPROVAL_DEBOUNCE_MS = 30_000;
/** chat.origin marker for regression chats (0 = page, 1 = mcp). */
const CHAT_ORIGIN_REGRESSION = 2;

export interface RegressionCaseUpsertInput {
  id?: number;
  datasourceId: number;
  name: string;
  question: string;
  metricCode?: string | null;
  tolerancePct?: number;
  enabled?: boolean;
}

@Injectable()
export class RegressionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegressionService.name);
  /** Per-oid serialized run queue (FIFO; latest completion releases the key). */
  private readonly queues = new Map<number, Promise<void>>();
  /** Debounce state for approval-triggered runs. */
  private readonly approvalTimers = new Map<number, NodeJS.Timeout>();
  private readonly approvalPayload = new Map<
    number,
    { entityTypes: string[]; latest: Record<string, unknown> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly datasourceService: DatasourceService,
    private readonly chatService: ChatService,
    private readonly audit: AuditService,
    private readonly trigger: RegressionTriggerService,
  ) {}

  onModuleInit(): void {
    const launcher: RegressionRunLauncher = (oid, entityType, detail) =>
      this.handleApproval(oid, entityType, detail);
    this.trigger.registerRunner(launcher);
  }

  onModuleDestroy(): void {
    for (const t of this.approvalTimers.values()) clearTimeout(t);
    this.approvalTimers.clear();
  }

  // --- case CRUD ----------------------------------------------------------

  async pageCases(
    oid: number,
    datasourceId: number | undefined,
    page: number,
    pageSize: number,
  ) {
    const where = {
      oid,
      ...(datasourceId ? { datasourceId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.regressionCase.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.regressionCase.count({ where }),
    ]);
    return { rows, total };
  }

  async upsertCase(
    oid: number,
    actorUid: number,
    dto: RegressionCaseUpsertInput,
  ) {
    if (!dto.name?.trim() || !dto.question?.trim()) {
      throw new BadRequestException(tr('regression.case_fields_required'));
    }
    if (
      dto.tolerancePct !== undefined &&
      (!Number.isInteger(dto.tolerancePct) ||
        dto.tolerancePct < 0 ||
        dto.tolerancePct > 100)
    ) {
      throw new BadRequestException(tr('regression.tolerance_invalid'));
    }
    const ds = await this.prisma.datasource.findFirst({
      where: { id: dto.datasourceId, oid },
      select: { id: true },
    });
    if (!ds) throw new NotFoundException(tr('regression.datasource_not_found'));

    if (dto.id) {
      const existing = await this.prisma.regressionCase.findFirst({
        where: { id: dto.id, oid },
      });
      if (!existing)
        throw new NotFoundException(tr('regression.case_not_found'));
      // The stored baseline belongs to the OLD question/datasource. Keeping it
      // would compare a different query's aggregates against this snapshot and
      // produce false passes/flags; the next run captures a fresh reference.
      const resetBaseline =
        dto.question.trim() !== existing.question ||
        dto.datasourceId !== existing.datasourceId;
      const row = await this.prisma.regressionCase.update({
        where: { id: dto.id },
        data: {
          datasourceId: dto.datasourceId,
          name: dto.name.trim(),
          question: dto.question.trim(),
          metricCode: dto.metricCode?.trim() || null,
          tolerancePct: dto.tolerancePct ?? existing.tolerancePct,
          enabled: dto.enabled ?? existing.enabled,
          ...(resetBaseline ? { baseline: Prisma.DbNull } : {}),
        },
      });
      return { id: row.id };
    }
    const row = await this.prisma.regressionCase.create({
      data: {
        oid,
        datasourceId: dto.datasourceId,
        name: dto.name.trim(),
        question: dto.question.trim(),
        metricCode: dto.metricCode?.trim() || null,
        tolerancePct: dto.tolerancePct ?? 10,
        enabled: dto.enabled ?? true,
        createBy: actorUid,
      },
    });
    return { id: row.id };
  }

  async removeCase(oid: number, id: number) {
    const existing = await this.prisma.regressionCase.findFirst({
      where: { id, oid },
    });
    if (!existing) throw new NotFoundException(tr('regression.case_not_found'));
    await this.prisma.regressionCase.delete({ where: { id } });
  }

  async setCaseEnabled(oid: number, id: number, enabled: boolean) {
    const existing = await this.prisma.regressionCase.findFirst({
      where: { id, oid },
    });
    if (!existing) throw new NotFoundException(tr('regression.case_not_found'));
    await this.prisma.regressionCase.update({
      where: { id },
      data: { enabled },
    });
  }

  // --- runs ---------------------------------------------------------------

  /** API-triggered run (/meta/regression/run — future CI pipelines): the
   *  ApiKey owner must administer the workspace (a run spends LLM budget). */
  async startApiRun(user: CurrentUserInfo): Promise<number> {
    const membership = await this.prisma.userWs.findFirst({
      where: { uid: user.id, oid: user.oid },
      select: { weight: true },
    });
    if (user.id !== ADMIN_UID && (membership?.weight ?? 0) === 0) {
      throw new ForbiddenException(tr('regression.api_run_forbidden'));
    }
    return this.startRun(user.oid, 'api', { actor_uid: user.id });
  }

  /** Create a run row and enqueue it. Returns the run id immediately —
   *  execution continues in the background (per-oid FIFO). */
  async startRun(
    oid: number,
    trigger: 'manual' | 'approval' | 'api',
    detail: Record<string, unknown> | null,
  ): Promise<number> {
    const run = await this.prisma.regressionRun.create({
      data: {
        oid,
        trigger,
        ...(detail ? { triggerDetail: detail as Prisma.InputJsonValue } : {}),
        status: 'running',
      },
    });
    this.enqueueRun(oid, run.id);
    return run.id;
  }

  async listRuns(oid: number, page: number, pageSize: number) {
    const where = { oid };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.regressionRun.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.regressionRun.count({ where }),
    ]);
    return { rows, total };
  }

  async runDetail(oid: number, runId: number) {
    const run = await this.prisma.regressionRun.findFirst({
      where: { id: runId, oid },
    });
    if (!run) throw new NotFoundException(tr('regression.run_not_found'));
    const cases = await this.prisma.regressionRunCase.findMany({
      where: { runId },
      orderBy: { caseId: 'asc' },
      include: { case: { select: { name: true, question: true } } },
    });
    return { run, cases };
  }

  /** Adopt a finished run's aggregates as the new baselines (explicit admin
   *  action — baselines never drift automatically). */
  async promote(oid: number, runId: number) {
    const run = await this.prisma.regressionRun.findFirst({
      where: { id: runId, oid },
    });
    if (!run) throw new NotFoundException(tr('regression.run_not_found'));
    if (run.status !== 'done')
      throw new BadRequestException(tr('regression.run_not_finished'));
    const rows = await this.prisma.regressionRunCase.findMany({
      where: { runId, status: { in: ['passed', 'flagged'] } },
    });
    const capturedAt = new Date().toISOString();
    await this.prisma.$transaction(
      rows.map((rc) =>
        this.prisma.regressionCase.update({
          where: { id: rc.caseId },
          data: {
            baseline: {
              rowCount: rc.rowCount ?? 0,
              sums: (rc.sums as Record<string, number>) ?? {},
              sqlHash: rc.sql ? sqlTextHash(rc.sql) : '',
              capturedAt,
              runId,
            },
          },
        }),
      ),
    );
    return { promoted: rows.length };
  }

  // --- internals ----------------------------------------------------------

  /** Approval hook (via RegressionTriggerService): coalesce a burst into one
   *  run after APPROVAL_DEBOUNCE_MS; runs queued behind an in-flight run
   *  naturally serialize via the per-oid FIFO. */
  private handleApproval(
    oid: number,
    entityType: string,
    detail: Record<string, unknown>,
  ): void {
    const payload = this.approvalPayload.get(oid) ?? {
      entityTypes: [],
      latest: detail,
    };
    if (!payload.entityTypes.includes(entityType)) {
      payload.entityTypes.push(entityType);
    }
    payload.latest = detail;
    this.approvalPayload.set(oid, payload);
    if (this.approvalTimers.has(oid)) return; // a debounce window is open
    const timer = setTimeout(() => {
      this.approvalTimers.delete(oid);
      const fired = this.approvalPayload.get(oid);
      this.approvalPayload.delete(oid);
      void this.startRun(oid, 'approval', {
        entity_types: fired?.entityTypes ?? [entityType],
        ...(fired?.latest ?? detail),
      }).catch((e) =>
        this.logger.error(
          `approval regression run create failed (oid=${oid}): ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }, APPROVAL_DEBOUNCE_MS);
    // unref: a pending debounce must never hold the event loop open (it kept
    // jest e2e workers alive after the suite summary).
    timer.unref();
    this.approvalTimers.set(oid, timer);
  }

  private enqueueRun(oid: number, runId: number): void {
    const prev = this.queues.get(oid) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.executeRun(oid, runId))
      .catch((e) =>
        this.logger.error(
          `regression run #${runId} crashed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    this.queues.set(oid, next);
    void next.then(() => {
      if (this.queues.get(oid) === next) this.queues.delete(oid);
    });
  }

  private async executeRun(oid: number, runId: number): Promise<void> {
    const run = await this.prisma.regressionRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.status !== 'running') return;
    try {
      const actor = await this.resolveActor(oid);
      const cases = await this.prisma.regressionCase.findMany({
        where: { oid, enabled: true },
        orderBy: { id: 'asc' },
      });
      if (!actor) {
        // No run-as identity — fail every case loudly instead of skipping the
        // run silently (misconfiguration must be visible on the runs page).
        await this.prisma.$transaction(
          cases.map((c) =>
            this.prisma.regressionRunCase.create({
              data: {
                runId,
                caseId: c.id,
                status: 'error',
                message: tr('regression.no_run_as_admin'),
              },
            }),
          ),
        );
        return;
      }
      // ONE ALS scope for the whole run: runPipeline (chat/record ownership),
      // execSql (currentOid) and the audit row all see the run-as actor, and
      // agent=regression exempts the run from the M7 query budgets.
      await requestContextStorage.run(
        {
          user: actor,
          agent: { type: 'regression' },
          acceptLanguage: actor.language,
        },
        async () => {
          for (const c of cases) {
            try {
              await this.runCase(actor, runId, c);
            } catch (e) {
              // A crash OUTSIDE runCase's own try (e.g. chat.create) must not
              // abort the remaining cases; record it and keep going.
              const msg = e instanceof Error ? e.message : String(e);
              this.logger.error(`regression case #${c.id} crashed: ${msg}`);
              await this.writeRunCase(runId, c.id, {
                status: 'error',
                message: msg,
              }).catch(() => undefined);
            }
          }
          void this.audit
            .record({
              module: OperationModule.REGRESSION,
              type: OperationType.SYNC,
              status: 'success',
              detail: `回归运行 #${runId}（${run.trigger}）`,
              resources: [{ name: 'regression_run', originId: runId }],
            })
            .catch(() => undefined);
        },
      );
    } catch (e) {
      // Aborted before/during the loop (resolveActor, cases query, ALS):
      // the finally below still marks the run terminal.
      this.logger.error(
        `regression run #${runId} aborted: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      await this.finishRun(runId).catch((e) =>
        this.logger.error(
          `regression run #${runId} finish failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    }
  }

  /** Run ONE case end-to-end. Never throws — every failure lands on the
   *  run-case row so a single bad case cannot kill the run. */
  private async runCase(
    actor: CurrentUserInfo,
    runId: number,
    c: RegressionCase,
  ): Promise<void> {
    const ds = await this.prisma.datasource.findFirst({
      where: { id: c.datasourceId, oid: c.oid },
    });
    if (!ds) {
      await this.writeRunCase(runId, c.id, {
        status: 'error',
        message: tr('regression.datasource_not_found'),
      });
      return;
    }
    // Direct prisma chat.create on purpose: ChatService.start() would run
    // maintainChatLimit, which deletes the actor's OLDEST chats — a long
    // regression run must never eat the admin's real conversations.
    const chat = await this.prisma.chat.create({
      data: {
        oid: c.oid,
        createBy: actor.id,
        datasourceId: c.datasourceId,
        engineType: engineFromDatasourceType(ds.type),
        title: `回归 · ${c.name}`.slice(0, 100),
        origin: CHAT_ORIGIN_REGRESSION,
        // Sentinel: generateAndCacheGuessQuestions skips any chat whose
        // recommendedQuestion is non-null. Without it every case would fire
        // an extra LLM recommendation call on a budget-exempt path (and race
        // the chat deletion below).
        recommendedQuestion: [],
      },
    });
    try {
      const collected = await collectPipeline(
        this.chatService.runPipeline(chat.id, c.question),
      );
      if (collected.clarify) {
        // The case question is too ambiguous for the current schema — a
        // case-quality problem, not a semantic regression.
        await this.writeRunCase(runId, c.id, {
          status: 'needs_clarify',
          recordId: collected.clarify.record_id,
          message: tr('regression.case_needs_clarify'),
        });
        return;
      }
      if (collected.error || !collected.sql) {
        await this.writeRunCase(runId, c.id, {
          status: 'error',
          sql: collected.sql ?? null,
          recordId: collected.recordId,
          message: collected.error ?? tr('regression.sql_missing'),
        });
        return;
      }
      // Numeric columns from the pipeline's stored sample rows.
      const record = collected.recordId
        ? await this.prisma.chatRecord.findUnique({
            where: { id: collected.recordId },
          })
        : null;
      const sample = (record?.sqlExecResult ?? null) as QueryResult | null;
      let numericCols = sample
        ? detectNumericColumns(sample.columns, sample.rows)
        : [];
      let sumsUnavailable = false;
      let verify: QueryResult;
      try {
        verify = await this.datasourceService.execSql(
          c.datasourceId,
          buildVerifySql(collected.sql, numericCols, ds.type),
        );
      } catch (e) {
        // Sample-based detection can classify a numeric-looking TEXT column
        // as numeric (bigint-as-string included), which the DB rejects in
        // SUM. Degrade to row-count comparison instead of erroring the case.
        if (numericCols.length === 0) throw e;
        this.logger.warn(
          `regression case #${c.id}: SUM probe failed, falling back to row count: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        sumsUnavailable = true;
        numericCols = [];
        verify = await this.datasourceService.execSql(
          c.datasourceId,
          buildVerifySql(collected.sql, [], ds.type),
        );
      }
      const agg = parseVerifyResult(numericCols, verify);
      const baseline = (c.baseline ??
        null) as unknown as RegressionBaseline | null;
      if (!baseline) {
        // First run captures the reference — nothing to compare yet.
        await this.prisma.$transaction([
          this.prisma.regressionRunCase.create({
            data: {
              runId,
              caseId: c.id,
              status: 'baseline_captured',
              sql: collected.sql,
              rowCount: agg.rowCount,
              sums: agg.sums,
              recordId: collected.recordId,
              message: sumsUnavailable
                ? tr('regression.sums_unavailable')
                : tr('regression.baseline_captured'),
            },
          }),
          this.prisma.regressionCase.update({
            where: { id: c.id },
            data: {
              baseline: {
                rowCount: agg.rowCount,
                sums: agg.sums,
                ...(sumsUnavailable ? { sumsUnavailable: true } : {}),
                sqlHash: sqlTextHash(collected.sql),
                capturedAt: new Date().toISOString(),
                runId,
              },
            },
          }),
        ]);
        return;
      }
      const delta = compareCase(baseline, agg, c.tolerancePct);
      await this.writeRunCase(runId, c.id, {
        status: delta.reasons.length > 0 ? 'flagged' : 'passed',
        sql: collected.sql,
        rowCount: agg.rowCount,
        sums: agg.sums,
        delta,
        recordId: collected.recordId,
        message: sumsUnavailable
          ? tr('regression.sums_unavailable')
          : undefined,
      });
    } catch (e) {
      await this.writeRunCase(runId, c.id, {
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => undefined);
    } finally {
      // Everything worth keeping is snapshotted on the run-case row; the
      // transient chat (and its cascading records/logs) goes away.
      await this.prisma.chat
        .delete({ where: { id: chat.id } })
        .catch(() => undefined);
    }
  }

  private async writeRunCase(
    runId: number,
    caseId: number,
    data: {
      status: string;
      sql?: string | null;
      rowCount?: number | null;
      sums?: Record<string, number>;
      delta?: CaseDelta;
      recordId?: number | null;
      message?: string | null;
    },
  ): Promise<void> {
    await this.prisma.regressionRunCase.create({
      data: {
        runId,
        caseId,
        status: data.status,
        sql: data.sql ?? null,
        rowCount: data.rowCount ?? null,
        ...(data.sums ? { sums: data.sums } : {}),
        ...(data.delta
          ? { delta: data.delta as unknown as Prisma.InputJsonValue }
          : {}),
        recordId: data.recordId ?? null,
        message: data.message ?? null,
      },
    });
  }

  private async finishRun(runId: number): Promise<void> {
    const grouped = await this.prisma.regressionRunCase.groupBy({
      by: ['status'],
      where: { runId },
      _count: { _all: true },
    });
    const countOf = (s: string) =>
      grouped.find((g) => g.status === s)?._count._all ?? 0;
    const errored = countOf('error') + countOf('needs_clarify');
    await this.prisma.regressionRun.update({
      where: { id: runId },
      data: {
        status: 'done',
        passed: countOf('passed') + countOf('baseline_captured'),
        flagged: countOf('flagged'),
        errored,
        finishedAt: new Date(),
      },
    });
  }

  /** Any enabled workspace admin of the oid (weight ≠ 0), uid 1 as the
   *  global fallback — the same authority metadata-sync's run-as resolution
   *  demands. The actor's OWN chats are never touched (see runCase). */
  private async resolveActor(oid: number): Promise<CurrentUserInfo | null> {
    const admin = await this.prisma.user.findFirst({
      where: {
        status: 1,
        OR: [
          { id: ADMIN_UID },
          { userWorkspaces: { some: { oid, weight: { not: 0 } } } },
        ],
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        account: true,
        language: true,
        userWorkspaces: { select: { oid: true, weight: true } },
      },
    });
    if (!admin) return null;
    const membership = admin.userWorkspaces.find((m) => m.oid === oid);
    return {
      id: admin.id,
      account: admin.account,
      oid,
      language: admin.language,
      weight: membership?.weight ?? (admin.id === ADMIN_UID ? 1 : 0),
    };
  }
}
