// Per-subject daily LLM character budgets (MetaDataImprove M7). Every chat
// generator call is charged: the full prompt (system + history + task) is
// reserved BEFORE the provider stream starts, and the produced content is
// added afterwards. Reasoning/thinking text, embeddings, and the admin model
// connectivity test are NOT counted.
//
// Counting is one atomic check-and-increment statement for the input side: a
// REJECTED call does not consume budget (it never reached the LLM), and
// concurrent calls cannot all pass the read — the conditional insert/update
// only increments while the stored count plus the prompt stays within the
// limit. Output is charged unconditionally afterwards, so a single response
// may overshoot by its own tail (documented limitation, not a bug).
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

/** Thrown when the subject's daily character budget is spent. The chat
 *  pipeline turns it into the standard record-failed SSE frame; surfaces the
 *  limit for i18n. */
export class QuotaExceededError extends Error {
  constructor(readonly dailyLimit: number) {
    super(`daily LLM character budget of ${dailyLimit} exceeded`);
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

  /** Effective daily character limit for the subject, or null = unlimited. */
  private async resolveLimit(
    oid: number,
    subject: QuerySubject,
  ): Promise<number | null> {
    if (subject.type === 'regression') return null;
    const rows = await this.prisma.queryBudget.findMany({
      where: {
        oid,
        OR: [
          { subjectType: subject.type, subjectId: subject.id },
          { subjectType: 'default', subjectId: 0 },
        ],
      },
    });
    return pickDailyLimit(rows, subject);
  }

  /** Fast pre-flight check used at the pipeline entry: fails when today's
   *  usage already reached the limit. It does NOT consume budget — the actual
   *  charge happens per generator call via reserveChars/chargeChars. */
  async assertUnderBudget(oid: number, subject: QuerySubject): Promise<void> {
    if (subject.type === 'regression') return;
    const limit = await this.resolveLimit(oid, subject);
    if (limit == null) return;
    const usage = await this.prisma.queryUsageDaily.findUnique({
      where: {
        oid_day_subjectType_subjectId: {
          oid,
          day: dayKey(),
          subjectType: subject.type,
          subjectId: subject.id ?? 0,
        },
      },
      select: { llmChars: true },
    });
    if ((usage?.llmChars ?? 0) >= limit) {
      throw new QuotaExceededError(limit);
    }
  }

  /** Reserve the prompt's character count before calling the LLM. Atomic and
   *  conditional: the INSERT ... SELECT is skipped when the prompt alone
   *  exceeds the limit, and the conflict-path UPDATE only applies while the
   *  stored count plus the prompt stays within the limit. Zero returned rows
   *  means the budget is exhausted and nothing was consumed. */
  async reserveChars(
    oid: number,
    subject: QuerySubject,
    chars: number,
  ): Promise<void> {
    if (subject.type === 'regression' || chars <= 0) return;
    const limit = await this.resolveLimit(oid, subject);
    if (limit == null) return; // no budget configured → unlimited
    const day = dayKey();
    const rows = await this.prisma.$queryRaw<Array<{ llmChars: number }>>`
      INSERT INTO "QueryUsageDaily"
        ("oid", "day", "subjectType", "subjectId", "llmChars", "updatedAt")
      SELECT ${oid}, ${day}, ${subject.type}, ${subject.id ?? 0}, ${chars}, NOW()
      WHERE ${chars} <= ${limit}
      ON CONFLICT ("oid", "day", "subjectType", "subjectId")
      DO UPDATE SET
        "llmChars" = "QueryUsageDaily"."llmChars" + ${chars},
        "updatedAt" = NOW()
      WHERE "QueryUsageDaily"."llmChars" + ${chars} <= ${limit}
      RETURNING "llmChars"
    `;
    if (rows.length === 0) throw new QuotaExceededError(limit);
  }

  /** Add the produced output characters after the stream ends. Unconditional
   *  by design: the response has already been generated, so this may push the
   *  day's usage past the limit by at most the tail of one response. */
  async chargeChars(
    oid: number,
    subject: QuerySubject,
    chars: number,
  ): Promise<void> {
    if (subject.type === 'regression' || chars <= 0) return;
    const limit = await this.resolveLimit(oid, subject);
    if (limit == null) return; // unlimited subjects are not tracked
    const day = dayKey();
    await this.prisma.$executeRaw`
      INSERT INTO "QueryUsageDaily"
        ("oid", "day", "subjectType", "subjectId", "llmChars", "updatedAt")
      VALUES (${oid}, ${day}, ${subject.type}, ${subject.id ?? 0}, ${chars}, NOW())
      ON CONFLICT ("oid", "day", "subjectType", "subjectId")
      DO UPDATE SET
        "llmChars" = "QueryUsageDaily"."llmChars" + ${chars},
        "updatedAt" = NOW()
    `;
  }

  /** Budget rows + today's usage for the admin page. The default row's
   *  used_today aggregates every subject INHERITING it today (subjects with
   *  their own row are excluded — their usage shows on their own row).
   *  All usage values are CHARACTER counts, not query counts. */
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
      .reduce((sum, u) => sum + u.llmChars, 0);
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
            )?.llmChars ?? 0),
      updated_at: b.updatedAt,
    }));
  }

  /** Upsert one budget row (workspace default or a specific subject).
   *  `daily_limit` is a daily LLM interaction CHARACTER count. */
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
