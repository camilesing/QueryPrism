// Per-subject daily query budgets (MetaDataImprove M7). The chat pipeline
// calls assertWithinBudget once per accepted question, BEFORE the LLM runs —
// that is the only reliable chokepoint for agent traffic.
//
// Counting is check-then-increment inside a transaction: a REJECTED request
// does not consume budget (it never reached the LLM); two concurrent requests
// racing past the read can overshoot by a hair, which is fine — this is cost
// control, not precise metering.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import {
  BUDGET_SUBJECT_TYPES,
  dayKey,
  pickDailyLimit,
  resolveSubject,
  type QuerySubject,
} from './quota-policy';

/** Thrown when the subject's daily budget is spent. The chat pipeline turns
 *  it into the standard record-failed SSE frame; surfaces the limit for i18n. */
export class QuotaExceededError extends Error {
  constructor(readonly dailyLimit: number) {
    super(`daily query budget of ${dailyLimit} exceeded`);
  }
}

@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Current charging subject from the request context (assistant > agent >
   *  user). Null when no identity is attached (should not happen inside the
   *  authed pipeline; callers treat null as "cannot charge, allow"). */
  currentSubject(): QuerySubject | null {
    return resolveSubject(RequestContext.current());
  }

  /** Charge one query against the subject's daily budget; throws
   *  QuotaExceededError when spent. Regression subjects pass free. */
  async assertWithinBudget(oid: number, subject: QuerySubject): Promise<void> {
    if (subject.type === 'regression') return;
    const rows = await this.prisma.queryBudget.findMany({
      where: {
        oid,
        OR: [
          { subjectType: subject.type, subjectId: subject.id },
          { subjectType: 'default', subjectId: 0 },
        ],
      },
    });
    const limit = pickDailyLimit(rows, subject);
    if (limit == null) return; // no budget configured → unlimited
    const day = dayKey();
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.queryUsageDaily.findUnique({
        where: {
          oid_day_subjectType_subjectId: {
            oid,
            day,
            subjectType: subject.type,
            subjectId: subject.id ?? 0,
          },
        },
      });
      if (existing && existing.queries >= limit) {
        throw new QuotaExceededError(limit);
      }
      await tx.queryUsageDaily.upsert({
        where: {
          oid_day_subjectType_subjectId: {
            oid,
            day,
            subjectType: subject.type,
            subjectId: subject.id ?? 0,
          },
        },
        create: {
          oid,
          day,
          subjectType: subject.type,
          subjectId: subject.id ?? 0,
          queries: 1,
        },
        update: { queries: { increment: 1 } },
      });
    });
  }

  /** Budget rows + today's usage for the admin page. The default row's
   *  used_today aggregates every subject INHERITING it today (subjects with
   *  their own row are excluded — their usage shows on their own row). */
  async overview(oid: number) {
    const budgets = await this.prisma.queryBudget.findMany({
      where: { oid },
      orderBy: [{ subjectType: 'asc' }, { subjectId: 'asc' }],
    });
    const usage = await this.prisma.queryUsageDaily.findMany({
      where: { oid, day: dayKey() },
    });
    const hasOwnRow = new Set(
      budgets
        .filter((b) => b.subjectType !== 'default')
        .map((b) => `${b.subjectType}:${b.subjectId ?? 0}`),
    );
    const inheritedUsage = usage
      .filter((u) => !hasOwnRow.has(`${u.subjectType}:${u.subjectId}`))
      .reduce((sum, u) => sum + u.queries, 0);
    return budgets.map((b) => ({
      id: b.id,
      subject_type: b.subjectType,
      subject_id: b.subjectId,
      daily_limit: b.dailyLimit,
      used_today:
        b.subjectType === 'default'
          ? inheritedUsage
          : (usage.find(
              (u) =>
                u.subjectType === b.subjectType &&
                u.subjectId === (b.subjectId ?? 0),
            )?.queries ?? 0),
      updated_at: b.updatedAt,
    }));
  }

  /** Upsert one budget row (workspace default or a specific subject). */
  async upsertBudget(
    oid: number,
    actorUid: number | undefined,
    body: {
      subject_type: string;
      subject_id?: number | null;
      daily_limit: number;
    },
  ) {
    const { subject_type, subject_id, daily_limit } = body;
    if (!BUDGET_SUBJECT_TYPES.includes(subject_type as never)) {
      throw new BadRequestException(
        tr('quota.invalid_subject_type', { type: subject_type }),
      );
    }
    if (!Number.isInteger(daily_limit) || daily_limit < 1) {
      throw new BadRequestException(tr('quota.invalid_daily_limit'));
    }
    if (subject_type === 'default' && subject_id != null && subject_id !== 0) {
      throw new BadRequestException(tr('quota.default_has_no_subject'));
    }
    if (subject_type !== 'default' && !Number.isInteger(subject_id)) {
      throw new BadRequestException(tr('quota.subject_id_required'));
    }
    // The default row stores subjectId 0: PostgreSQL unique indexes treat
    // NULLs as mutually distinct, so a NULL-keyed default row would escape
    // the (oid, subjectType, subjectId) uniqueness (same class of problem
    // the semantic natural-key migration solved with a partial index).
    const subjectId = subject_type === 'default' ? 0 : (subject_id as number);
    const row = await this.prisma.queryBudget.upsert({
      where: {
        oid_subjectType_subjectId: {
          oid,
          subjectType: subject_type,
          subjectId,
        },
      },
      create: {
        oid,
        subjectType: subject_type,
        subjectId,
        dailyLimit: daily_limit,
        createBy: actorUid,
      },
      update: { dailyLimit: daily_limit },
    });
    return { id: row.id };
  }

  /** Remove one budget row (back to inheriting the default / unlimited). */
  async removeBudget(oid: number, id: number) {
    const existing = await this.prisma.queryBudget.findFirst({
      where: { id, oid },
    });
    if (!existing) throw new NotFoundException(tr('quota.budget_not_found'));
    await this.prisma.queryBudget.delete({ where: { id } });
  }
}
