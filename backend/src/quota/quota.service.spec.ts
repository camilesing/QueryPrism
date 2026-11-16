// QuotaService spec — locks the M7 budget enforcement surface: subject
// attribution through the request ALS context (assistant > agent > user),
// limit resolution (own row > workspace default > unlimited), the atomic
// reserveChars INSERT..SELECT call shape (a rejected call consumes nothing),
// the unconditional chargeChars upsert (documented one-tail overshoot), the
// read-only assertUnderBudget gate, the local-midnight day rollover, the
// admin overview aggregation (default row aggregates inheriting subjects),
// and upsertBudget/removeBudget validation. Prisma is a jest.Mock — the raw
// SQL branches are asserted by inspecting the tagged-template calls.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { dayKey } from './quota-policy';
import { QuotaExceededError, QuotaService } from './quota.service';

function makePrisma() {
  return {
    queryBudget: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    queryUsageDaily: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function makeService() {
  const prisma = makePrisma();
  return {
    service: new QuotaService(prisma as unknown as PrismaService),
    prisma,
  };
}

function withCtx<T>(
  store: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(store, fn);
}

/** The raw-SQL tagged template call: [templateStrings, ...params]. */
function rawCall(call: unknown[]): { sql: string; params: unknown[] } {
  const strings = call[0] as readonly string[];
  return { sql: strings.join('$'), params: call.slice(1) };
}

function budgetRow(
  partial: Partial<Record<string, unknown>> & { subjectType: string },
) {
  return {
    id: 1,
    oid: 1,
    subjectId: 0,
    dailyLimit: 1000,
    createBy: null,
    updatedAt: new Date('2026-11-16T00:00:00Z'),
    ...partial,
  };
}

describe('QuotaService', () => {
  beforeEach(() => setI18n(createTestI18n()));

  // --- currentSubject (assistant > agent > user via the ALS context) ----

  describe('currentSubject', () => {
    it('prefers the assistant header over agent and user', async () => {
      const { service } = makeService();
      const subject = await withCtx(
        {
          user: { id: 7, oid: 1 },
          agent: { type: 'mcp_integration', id: 9 },
          assistant: {
            id: 42,
            oid: 1,
            type: 4,
            domain: null,
            configuration: null,
            appId: 'a',
          },
        },
        () => Promise.resolve(service.currentSubject()),
      );
      expect(subject).toEqual({ type: 'assistant', id: 42 });
    });

    it('attributes MCP transport traffic to the integration', async () => {
      const { service } = makeService();
      const subject = await withCtx(
        { user: { id: 7, oid: 1 }, agent: { type: 'mcp_integration', id: 9 } },
        () => Promise.resolve(service.currentSubject()),
      );
      expect(subject).toEqual({ type: 'mcp_integration', id: 9 });
    });

    it('falls back to the plain page user', async () => {
      const { service } = makeService();
      const subject = await withCtx({ user: { id: 7, oid: 1 } }, () =>
        Promise.resolve(service.currentSubject()),
      );
      expect(subject).toEqual({ type: 'user', id: 7 });
    });

    it('returns null outside any request context (cannot charge → allow)', () => {
      const { service } = makeService();
      expect(service.currentSubject()).toBeNull();
    });
  });

  // --- subject-resolution matrix through resolveLimit -------------------

  describe('limit resolution (own row > default row > unlimited)', () => {
    it('queries own row OR the default sentinel row in one findMany', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 100 }),
      ]);
      await service.assertUnderBudget(1, { type: 'user', id: 7 });
      expect(prisma.queryBudget.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          OR: [
            { subjectType: 'user', subjectId: 7 },
            { subjectType: 'default', subjectId: 0 },
          ],
        },
      });
    });

    it('the subject own row wins over the default row (limit 500 flows into the SQL)', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 100 }),
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 500 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([{ llmChars: 500 }]);
      await service.reserveChars(1, { type: 'user', id: 7 }, 500);
      const { params } = rawCall(prisma.$queryRaw.mock.calls[0] as unknown[]);
      // 7th param = the limit used by the WHERE ${chars} <= ${limit} guard.
      expect(params[6]).toBe(500);
    });

    it('falls back to the default row for subjects without an own row', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 100 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([{ llmChars: 100 }]);
      await service.reserveChars(1, { type: 'mcp_integration', id: 3 }, 100);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const { params } = rawCall(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(params[6]).toBe(100);
    });

    it('no rows at all → unlimited → nothing is reserved or tracked', async () => {
      const { service, prisma } = makeService();
      await service.reserveChars(1, { type: 'user', id: 7 }, 100);
      await service.chargeChars(1, { type: 'user', id: 7 }, 100);
      await service.assertUnderBudget(1, { type: 'user', id: 7 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.queryUsageDaily.findUnique).not.toHaveBeenCalled();
    });
  });

  // --- assertUnderBudget (read-only fast fail) ---------------------------

  describe('assertUnderBudget', () => {
    it('regression subjects are exempt — no prisma call at all', async () => {
      const { service, prisma } = makeService();
      await service.assertUnderBudget(1, { type: 'regression', id: null });
      expect(prisma.queryBudget.findMany).not.toHaveBeenCalled();
      expect(prisma.queryUsageDaily.findUnique).not.toHaveBeenCalled();
    });

    it('looks up TODAY usage under the compound unique key (subjectId null → 0)', async () => {
      const { service, prisma } = makeService();
      // A null-id subject never matches an own row (subjectId === null is
      // always false) — it inherits the workspace default row.
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 100 }),
      ]);
      prisma.queryUsageDaily.findUnique.mockResolvedValue({ llmChars: 99 });
      await service.assertUnderBudget(1, { type: 'mcp_integration', id: null });
      expect(prisma.queryUsageDaily.findUnique).toHaveBeenCalledWith({
        where: {
          oid_day_subjectType_subjectId: {
            oid: 1,
            day: dayKey(),
            subjectType: 'mcp_integration',
            subjectId: 0,
          },
        },
        select: { llmChars: true },
      });
    });

    it('no usage row yet → treated as 0 → passes', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 10 }),
      ]);
      prisma.queryUsageDaily.findUnique.mockResolvedValue(null);
      await expect(
        service.assertUnderBudget(1, { type: 'user', id: 7 }),
      ).resolves.toBeUndefined();
    });

    it('usage at or beyond the limit → QuotaExceededError carrying the limit', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 10 }),
      ]);
      prisma.queryUsageDaily.findUnique.mockResolvedValue({ llmChars: 10 });
      const promise = service.assertUnderBudget(1, { type: 'user', id: 7 });
      await expect(promise).rejects.toBeInstanceOf(QuotaExceededError);
      await expect(promise).rejects.toMatchObject({ dailyLimit: 10 });
    });

    it('never consumes budget — no raw write statements', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 10 }),
      ]);
      prisma.queryUsageDaily.findUnique.mockResolvedValue({ llmChars: 10 });
      await service
        .assertUnderBudget(1, { type: 'user', id: 7 })
        .catch(() => undefined);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // --- reserveChars (atomic conditional INSERT..SELECT) ------------------

  describe('reserveChars', () => {
    it('regression subjects and non-positive char counts are no-ops', async () => {
      const { service, prisma } = makeService();
      await service.reserveChars(1, { type: 'regression', id: null }, 100);
      await service.reserveChars(1, { type: 'user', id: 7 }, 0);
      await service.reserveChars(1, { type: 'user', id: 7 }, -5);
      expect(prisma.queryBudget.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('issues the atomic conditional INSERT..SELECT with the exact call shape', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 1000 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([{ llmChars: 600 }]);
      await service.reserveChars(1, { type: 'user', id: 7 }, 500);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const { sql, params } = rawCall(
        prisma.$queryRaw.mock.calls[0] as unknown[],
      );
      // The statement is one atomic check-and-increment: INSERT .. SELECT
      // guarded by WHERE chars <= limit, with the conflict-path UPDATE
      // guarded the same way, RETURNING the new count.
      expect(sql).toContain('INSERT INTO "QueryUsageDaily"');
      expect(sql).toContain('SELECT $, $, $, $, $, NOW()');
      expect(sql).toContain('WHERE $ <= $');
      expect(sql).toContain(
        'ON CONFLICT ("oid", "day", "subjectType", "subjectId")',
      );
      expect(sql).toContain('"llmChars" = "QueryUsageDaily"."llmChars" + $');
      expect(sql).toContain('WHERE "QueryUsageDaily"."llmChars" + $ <= $');
      expect(sql).toContain('RETURNING "llmChars"');
      expect(params).toEqual([
        1,
        dayKey(),
        'user',
        7,
        500, // inserted llmChars (SELECT column)
        500, // WHERE ${chars} <= ${limit}
        1000,
        500, // DO UPDATE increment
        500, // WHERE stored + ${chars} <= ${limit}
        1000,
      ]);
    });

    it('a null subject id is charged against the 0 sentinel row', async () => {
      const { service, prisma } = makeService();
      // Null id → no own-row match → inherits the default row, but the
      // written/charged usage row keys on subjectId 0.
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 100 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([{ llmChars: 50 }]);
      await service.reserveChars(1, { type: 'mcp_integration', id: null }, 50);
      const { params } = rawCall(prisma.$queryRaw.mock.calls[0] as unknown[]);
      expect(params[3]).toBe(0); // subjectId sentinel
    });

    it('zero returned rows → budget exhausted → nothing was consumed', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 100 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([]); // both WHERE guards rejected
      const promise = service.reserveChars(1, { type: 'user', id: 7 }, 500);
      await expect(promise).rejects.toBeInstanceOf(QuotaExceededError);
      await expect(promise).rejects.toMatchObject({ dailyLimit: 100 });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // no second attempt
    });
  });

  // --- chargeChars (unconditional output-side upsert) --------------------

  describe('chargeChars', () => {
    it('regression subjects and non-positive char counts are no-ops', async () => {
      const { service, prisma } = makeService();
      await service.chargeChars(1, { type: 'regression', id: null }, 100);
      await service.chargeChars(1, { type: 'user', id: 7 }, 0);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('unlimited subjects are not tracked (no row written)', async () => {
      const { service, prisma } = makeService();
      await service.chargeChars(1, { type: 'user', id: 7 }, 100);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('issues the unconditional upsert with the exact call shape', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({
          subjectType: 'assistant',
          subjectId: 42,
          dailyLimit: 1000,
        }),
      ]);
      await service.chargeChars(1, { type: 'assistant', id: 42 }, 250);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const { sql, params } = rawCall(
        prisma.$executeRaw.mock.calls[0] as unknown[],
      );
      // Unconditional by design: INSERT VALUES + ON CONFLICT DO UPDATE with
      // NO WHERE guard (the response is already generated) and no RETURNING.
      expect(sql).toContain('INSERT INTO "QueryUsageDaily"');
      expect(sql).toContain('VALUES ($, $, $, $, $, NOW())');
      expect(sql).toContain(
        'ON CONFLICT ("oid", "day", "subjectType", "subjectId")',
      );
      expect(sql).toContain('"llmChars" = "QueryUsageDaily"."llmChars" + $');
      expect(sql).not.toContain('RETURNING');
      expect(params).toEqual([1, dayKey(), 'assistant', 42, 250, 250]);
    });

    it('a null subject id is charged against the 0 sentinel row', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'default', subjectId: 0, dailyLimit: 1000 }),
      ]);
      await service.chargeChars(1, { type: 'mcp_integration', id: null }, 25);
      const { params } = rawCall(prisma.$executeRaw.mock.calls[0] as unknown[]);
      expect(params[3]).toBe(0); // subjectId sentinel
    });
  });

  // --- local-midnight day rollover ---------------------------------------

  describe('usage resets at the local calendar midnight (dayKey rollover)', () => {
    // Jest 30.5.2 / Node 26: useRealTimers() deletes global
    // setInterval/clearInterval — capture and restore them around the fake.
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;

    afterEach(() => {
      jest.useRealTimers();
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    });

    it('before and after midnight resolve to different usage rows', async () => {
      jest.useFakeTimers();
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 100 }),
      ]);
      prisma.queryUsageDaily.findUnique.mockResolvedValue({ llmChars: 100 });

      jest.setSystemTime(new Date(2026, 10, 16, 23, 59, 59));
      await expect(
        service.assertUnderBudget(1, { type: 'user', id: 7 }),
      ).rejects.toMatchObject({ dailyLimit: 100 });
      expect(
        prisma.queryUsageDaily.findUnique.mock.calls[0][0].where
          .oid_day_subjectType_subjectId.day,
      ).toBe('2026-11-16');

      // One second past LOCAL midnight → a different day key → a different
      // usage row → the day's budget starts fresh (usage 0 < limit again).
      jest.setSystemTime(new Date(2026, 10, 17, 0, 0, 1));
      prisma.queryUsageDaily.findUnique.mockResolvedValue(null);
      await expect(
        service.assertUnderBudget(1, { type: 'user', id: 7 }),
      ).resolves.toBeUndefined();
      expect(
        prisma.queryUsageDaily.findUnique.mock.calls[1][0].where
          .oid_day_subjectType_subjectId.day,
      ).toBe('2026-11-17');
    });

    it('reserveChars stamps the rolled-over day into the row it writes', async () => {
      jest.useFakeTimers();
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([
        budgetRow({ subjectType: 'user', subjectId: 7, dailyLimit: 100 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([{ llmChars: 10 }]);

      jest.setSystemTime(new Date(2026, 10, 16, 23, 59, 59, 999));
      await service.reserveChars(1, { type: 'user', id: 7 }, 10);
      jest.setSystemTime(new Date(2026, 10, 17, 0, 0, 0, 1));
      await service.reserveChars(1, { type: 'user', id: 7 }, 10);

      const first = rawCall(prisma.$queryRaw.mock.calls[0] as unknown[])
        .params[1];
      const second = rawCall(prisma.$queryRaw.mock.calls[1] as unknown[])
        .params[1];
      expect(first).toBe('2026-11-16');
      expect(second).toBe('2026-11-17');
    });
  });

  // --- overview (admin page aggregation) ----------------------------------

  describe('overview', () => {
    it('aggregates inheriting usage onto the default row; own rows read their own usage', async () => {
      const { service, prisma } = makeService();
      const updated = new Date('2026-11-16T08:00:00Z');
      prisma.queryBudget.findMany.mockResolvedValue([
        {
          id: 1,
          subjectType: 'default',
          subjectId: 0,
          dailyLimit: 1000,
          updatedAt: updated,
        },
        {
          id: 2,
          subjectType: 'user',
          subjectId: 7,
          dailyLimit: 500,
          updatedAt: updated,
        },
        {
          id: 3,
          subjectType: 'assistant',
          subjectId: null,
          dailyLimit: 300,
          updatedAt: updated,
        },
        {
          id: 4,
          subjectType: 'user',
          subjectId: 9,
          dailyLimit: 200,
          updatedAt: updated,
        },
      ]);
      prisma.queryUsageDaily.findMany.mockResolvedValue([
        {
          oid: 1,
          day: dayKey(),
          subjectType: 'user',
          subjectId: 8,
          llmChars: 50,
        },
        {
          oid: 1,
          day: dayKey(),
          subjectType: 'user',
          subjectId: 7,
          llmChars: 200,
        },
        {
          oid: 1,
          day: dayKey(),
          subjectType: 'assistant',
          subjectId: 0,
          llmChars: 120,
        },
      ]);
      const out = await service.overview(1);

      expect(prisma.queryUsageDaily.findMany).toHaveBeenCalledWith({
        where: { oid: 1, day: dayKey() },
      });
      expect(out).toEqual([
        // user:8 has no own budget row → inherits the default (50 chars).
        {
          id: 1,
          subject_type: 'default',
          subject_id: 0,
          daily_limit: 1000,
          used_today: 50,
          updated_at: updated,
        },
        // user:7 has an own row → its usage is NOT double-counted on default.
        {
          id: 2,
          subject_type: 'user',
          subject_id: 7,
          daily_limit: 500,
          used_today: 200,
          updated_at: updated,
        },
        // null subjectId is keyed as the 0 sentinel on both sides.
        {
          id: 3,
          subject_type: 'assistant',
          subject_id: null,
          daily_limit: 300,
          used_today: 120,
          updated_at: updated,
        },
        // no usage today → 0.
        {
          id: 4,
          subject_type: 'user',
          subject_id: 9,
          daily_limit: 200,
          used_today: 0,
          updated_at: updated,
        },
      ]);
    });

    it('orders budgets by subjectType then subjectId (admin display order)', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findMany.mockResolvedValue([]);
      prisma.queryUsageDaily.findMany.mockResolvedValue([]);
      await service.overview(1);
      expect(prisma.queryBudget.findMany).toHaveBeenCalledWith({
        where: { oid: 1 },
        orderBy: [{ subjectType: 'asc' }, { subjectId: 'asc' }],
      });
    });
  });

  // --- upsertBudget (admin row validation + write) ------------------------

  describe('upsertBudget', () => {
    it('rejects an unknown subject type', async () => {
      const { service } = makeService();
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'team',
          subject_id: 5,
          daily_limit: 100,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'team',
          subject_id: 5,
          daily_limit: 100,
        }),
      ).rejects.toThrow(/Unknown budget subject type: team/);
    });

    it('rejects a non-integer or non-positive daily limit', async () => {
      const { service } = makeService();
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'user',
          subject_id: 5,
          daily_limit: 1.5,
        }),
      ).rejects.toThrow(/positive integer/);
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'user',
          subject_id: 5,
          daily_limit: 0,
        }),
      ).rejects.toThrow(/positive integer/);
    });

    it('the default row admits no subject id (0 sentinel or null only)', async () => {
      const { service } = makeService();
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'default',
          subject_id: 5,
          daily_limit: 100,
        }),
      ).rejects.toThrow(/no subject id/);
      // both accepted spellings of "the default row"
      const { service: s2, prisma } = makeService();
      prisma.queryBudget.upsert.mockResolvedValue(
        budgetRow({ subjectType: 'default' }),
      );
      await s2.upsertBudget(1, 1, {
        subject_type: 'default',
        subject_id: null,
        daily_limit: 100,
      });
      await s2.upsertBudget(1, 1, {
        subject_type: 'default',
        subject_id: 0,
        daily_limit: 100,
      });
      expect(prisma.queryBudget.upsert).toHaveBeenCalledTimes(2);
    });

    it('non-default subjects require an integer subject id', async () => {
      const { service } = makeService();
      await expect(
        service.upsertBudget(1, 1, { subject_type: 'user', daily_limit: 100 }),
      ).rejects.toThrow(/subject id is required/);
      await expect(
        service.upsertBudget(1, 1, {
          subject_type: 'user',
          subject_id: 1.5,
          daily_limit: 100,
        }),
      ).rejects.toThrow(/subject id is required/);
    });

    it('upserts against the compound unique key and returns the row id', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.upsert.mockResolvedValue(
        budgetRow({
          id: 77,
          subjectType: 'user',
          subjectId: 42,
          dailyLimit: 100,
        }),
      );
      const out = await service.upsertBudget(1, 3, {
        subject_type: 'user',
        subject_id: 42,
        daily_limit: 100,
      });
      expect(out).toEqual({ id: 77 });
      expect(prisma.queryBudget.upsert).toHaveBeenCalledWith({
        where: {
          oid_subjectType_subjectId: {
            oid: 1,
            subjectType: 'user',
            subjectId: 42,
          },
        },
        create: {
          oid: 1,
          subjectType: 'user',
          subjectId: 42,
          dailyLimit: 100,
          createBy: 3,
        },
        update: { dailyLimit: 100 },
      });
    });

    it('a default upsert always stores subjectId 0 (NULL would escape uniqueness)', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.upsert.mockResolvedValue(
        budgetRow({ subjectType: 'default' }),
      );
      await service.upsertBudget(1, 1, {
        subject_type: 'default',
        daily_limit: 100,
      });
      const call = prisma.queryBudget.upsert.mock.calls[0][0];
      expect(call.where.oid_subjectType_subjectId.subjectId).toBe(0);
      expect(call.create.subjectId).toBe(0);
    });
  });

  // --- removeBudget --------------------------------------------------------

  describe('removeBudget', () => {
    it('404s when the row does not exist in this workspace', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findFirst.mockResolvedValue(null);
      await expect(service.removeBudget(1, 55)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.removeBudget(1, 55)).rejects.toThrow(
        /budget row not found/,
      );
      expect(prisma.queryBudget.delete).not.toHaveBeenCalled();
    });

    it('deletes the row once found in the workspace', async () => {
      const { service, prisma } = makeService();
      prisma.queryBudget.findFirst.mockResolvedValue(budgetRow({ id: 55 }));
      await expect(service.removeBudget(1, 55)).resolves.toBeUndefined();
      expect(prisma.queryBudget.findFirst).toHaveBeenCalledWith({
        where: { id: 55, oid: 1 },
      });
      expect(prisma.queryBudget.delete).toHaveBeenCalledWith({
        where: { id: 55 },
      });
    });
  });
});
