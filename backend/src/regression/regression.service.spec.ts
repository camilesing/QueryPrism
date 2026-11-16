// RegressionService unit tests (MetaDataImprove M6): case CRUD validation,
// run lifecycle (create → FIFO enqueue → execute → finish), the approval
// debounce, per-case crash isolation, baseline capture/compare/promote and
// run-as actor resolution. Prisma/Datasource/Chat/Audit/Trigger are jest
// mocks; regression-policy + collectPipeline stay REAL (pure helpers). The
// background queue is awaited through the service's internal queues map.
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Prisma, type RegressionCase } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  RequestContext,
  type CurrentUserInfo,
  type RequestContextData,
} from '../common/context/request-context';
import { OperationModule, OperationType } from '../audit/operation.enum';
import type { ChatSseEvent } from '../chat/chat-sse-event';
import { RegressionService } from './regression.service';
import type { RegressionRunLauncher } from './regression-trigger.service';
import { buildVerifySql, sqlTextHash } from './regression-policy';

// --- async-iterable helper (object form: no `async function*` so ESLint's
//     require-await stays quiet) -------------------------------------------
function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: () =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false as const, value: items[i++] }),
      };
    },
  };
}

// This Jest 30 install leaves the global setTimeout undefined after
// useRealTimers() has un-installed fake timers, so later real-timer tests
// must use the reference captured at module load (before any faking).
const realSetTimeout = globalThis.setTimeout;

type MockPrisma = {
  regressionCase: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  regressionRun: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  regressionRunCase: {
    findMany: jest.Mock;
    create: jest.Mock;
    groupBy: jest.Mock;
  };
  datasource: { findFirst: jest.Mock };
  chat: { create: jest.Mock; delete: jest.Mock };
  chatRecord: { findUnique: jest.Mock };
  user: { findFirst: jest.Mock };
  userWs: { findFirst: jest.Mock };
  $transaction: jest.Mock;
};

/** Private members the tests drive/observe (TS allows this cast; the service's
 *  public surface is too fire-and-forget to reach them otherwise). */
type ServiceInternals = {
  queues: Map<number, Promise<void>>;
  approvalTimers: Map<number, NodeJS.Timeout>;
  approvalPayload: Map<number, { entityTypes: string[]; latest: unknown }>;
  logger: Logger;
  handleApproval: (
    oid: number,
    entityType: string,
    detail: Record<string, unknown>,
  ) => void;
  executeRun: (oid: number, runId: number) => Promise<void>;
  runCase: (
    actor: CurrentUserInfo,
    runId: number,
    c: RegressionCase,
  ) => Promise<void>;
  finishRun: (runId: number) => Promise<void>;
  resolveActor: (oid: number) => Promise<CurrentUserInfo | null>;
};

function internals(service: RegressionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

/** Wait until every queued run of the oid has settled. */
async function drainQueue(service: RegressionService, oid: number) {
  const pending = internals(service).queues.get(oid);
  if (pending) await pending;
}

function makePrisma(): MockPrisma {
  const prisma: MockPrisma = {
    regressionCase: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 99 }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    regressionRun: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 501 }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    regressionRunCase: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    datasource: { findFirst: jest.fn() },
    chat: {
      create: jest.fn().mockResolvedValue({ id: 900 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    chatRecord: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    userWs: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  // Array form → Promise.all; interactive form → callback on this client.
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: MockPrisma) => unknown)(prisma)
      : Promise.all(arg as unknown[]),
  );
  return prisma;
}

function makeService() {
  const prisma = makePrisma();
  const datasourceService = { execSql: jest.fn() };
  const chatService = { start: jest.fn(), runPipeline: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const trigger = { registerRunner: jest.fn() };
  const service = new RegressionService(
    prisma as never,
    datasourceService as never,
    chatService as never,
    audit as never,
    trigger as never,
  );
  // Silence + record the service's own logger (error/warn paths under test).
  const loggerError = jest
    .spyOn(internals(service).logger, 'error')
    .mockImplementation(() => undefined);
  const loggerWarn = jest
    .spyOn(internals(service).logger, 'warn')
    .mockImplementation(() => undefined);
  return {
    service,
    prisma,
    datasourceService,
    chatService,
    audit,
    trigger,
    loggerError,
    loggerWarn,
  };
}

// --- row factories ---------------------------------------------------------

function caseRow(over: Partial<RegressionCase> = {}): RegressionCase {
  return {
    id: 11,
    oid: 1,
    datasourceId: 5,
    name: '支付金额',
    question: '近7天支付金额',
    metricCode: null,
    tolerancePct: 10,
    enabled: true,
    baseline: null,
    createBy: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    oid: 1,
    trigger: 'manual',
    triggerDetail: null,
    status: 'running',
    passed: 0,
    flagged: 0,
    errored: 0,
    startedAt: new Date('2026-01-02T00:00:00Z'),
    finishedAt: null,
    ...over,
  };
}

/** A workspace-admin actor resolved by resolveActor. */
const ACTOR: CurrentUserInfo = {
  id: 2,
  account: 'wsadmin',
  oid: 1,
  language: 'en',
  weight: 2,
};

/** Successful pipeline events: record 77 + SQL; rows come from the stored
 *  ChatRecord sample (sqlExecResult), per the Phase 9c SSE contract. */
const SQL = 'SELECT region, amount FROM orders LIMIT 1000';
function okEvents(recordId = 77, sql = SQL): ChatSseEvent[] {
  return [
    { type: 'id', data: { id: recordId } },
    { type: 'sql', data: { content: sql } },
    { type: 'finish', data: {} },
  ];
}

/** Default happy-path wiring shared by the direct runCase tests. */
function wireHappyPipeline(m: ReturnType<typeof makeService>) {
  m.prisma.datasource.findFirst.mockResolvedValue({
    id: 5,
    oid: 1,
    type: 'postgres',
  });
  m.chatService.runPipeline.mockImplementation(() => asyncFrom(okEvents()));
  m.prisma.chatRecord.findUnique.mockResolvedValue({
    sqlExecResult: { columns: ['region', 'amount'], rows: [['north', 100]] },
  });
  // Sample says `amount` is numeric → verify = COUNT + SUM(amount).
  m.datasourceService.execSql.mockResolvedValue({
    columns: ['__cnt', '__s0'],
    rows: [[100, 1000]],
  });
}

describe('RegressionService', () => {
  beforeEach(() => setI18n(createTestI18n()));
  afterEach(() => {
    jest.useRealTimers();
  });

  // --- module lifecycle ----------------------------------------------------

  describe('onModuleInit / onModuleDestroy', () => {
    it('registers the trigger launcher; the launcher routes to handleApproval', async () => {
      const m = makeService();
      m.service.onModuleInit();
      expect(m.trigger.registerRunner).toHaveBeenCalledTimes(1);
      const launcher = m.trigger.registerRunner.mock
        .calls[0][0] as RegressionRunLauncher;
      m.prisma.regressionRun.create.mockResolvedValue({ id: 900 });

      jest.useFakeTimers();
      launcher(1, 'semantic', { requestId: 'r1' });
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ oid: 1, trigger: 'approval' }),
      });
    });

    it('onModuleDestroy clears a pending debounce window', async () => {
      const m = makeService();
      m.service.onModuleInit();
      const launcher = m.trigger.registerRunner.mock
        .calls[0][0] as RegressionRunLauncher;

      jest.useFakeTimers();
      launcher(1, 'semantic', { requestId: 'r1' });
      m.service.onModuleDestroy();
      expect(internals(m.service).approvalTimers.size).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(m.prisma.regressionRun.create).not.toHaveBeenCalled();
    });
  });

  // --- case CRUD -----------------------------------------------------------

  describe('pageCases', () => {
    it('filters by datasource and pages when datasourceId is given', async () => {
      const m = makeService();
      m.prisma.regressionCase.findMany.mockResolvedValue([caseRow()]);
      m.prisma.regressionCase.count.mockResolvedValue(41);
      const res = await m.service.pageCases(1, 7, 3, 20);
      expect(res).toEqual({ rows: [caseRow()], total: 41 });
      expect(m.prisma.regressionCase.findMany).toHaveBeenCalledWith({
        where: { oid: 1, datasourceId: 7 },
        orderBy: { id: 'asc' },
        skip: 40,
        take: 20,
      });
      expect(m.prisma.regressionCase.count).toHaveBeenCalledWith({
        where: { oid: 1, datasourceId: 7 },
      });
    });

    it('omits the datasource filter when undefined', async () => {
      const m = makeService();
      await m.service.pageCases(2, undefined, 1, 10);
      expect(m.prisma.regressionCase.findMany).toHaveBeenCalledWith({
        where: { oid: 2 },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 10,
      });
    });
  });

  describe('upsertCase', () => {
    const dto = {
      datasourceId: 5,
      name: '支付金额',
      question: '近7天支付金额',
    };

    it('rejects blank name / question', async () => {
      const m = makeService();
      await expect(
        m.service.upsertCase(1, 1, { ...dto, name: '  ' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        m.service.upsertCase(1, 1, { ...dto, question: '' }),
      ).rejects.toThrow('Case name and question are both required');
      await expect(
        m.service.upsertCase(1, 1, { ...dto, name: undefined }),
      ).rejects.toThrow(BadRequestException);
      expect(m.prisma.datasource.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a non-integer / out-of-range tolerance', async () => {
      const m = makeService();
      for (const tolerancePct of [1.5, -1, 101]) {
        await expect(
          m.service.upsertCase(1, 1, { ...dto, tolerancePct }),
        ).rejects.toThrow('Tolerance must be an integer between 0 and 100');
      }
    });

    it('rejects a datasource outside the workspace', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue(null);
      await expect(m.service.upsertCase(1, 1, dto)).rejects.toThrow(
        'The datasource does not exist in this workspace',
      );
    });

    it('creates with defaults (tolerance 10, enabled, null metricCode)', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      m.prisma.regressionCase.create.mockResolvedValue({ id: 31 });
      const res = await m.service.upsertCase(1, 8, {
        ...dto,
        name: ' n ',
        question: ' q ',
        metricCode: '   ',
      });
      expect(res).toEqual({ id: 31 });
      expect(m.prisma.regressionCase.create).toHaveBeenCalledWith({
        data: {
          oid: 1,
          datasourceId: 5,
          name: 'n',
          question: 'q',
          metricCode: null,
          tolerancePct: 10,
          enabled: true,
          createBy: 8,
        },
      });
    });

    it('creates honoring explicit tolerance/enabled/metricCode', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      await m.service.upsertCase(1, 8, {
        ...dto,
        metricCode: ' pay_amt ',
        tolerancePct: 25,
        enabled: false,
      });
      expect(m.prisma.regressionCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metricCode: 'pay_amt',
          tolerancePct: 25,
          enabled: false,
        }),
      });
    });

    it('update keeps the baseline when question/datasource are unchanged', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      m.prisma.regressionCase.findFirst.mockResolvedValue(
        caseRow({ id: 31, tolerancePct: 15, enabled: false }),
      );
      await m.service.upsertCase(1, 8, { ...dto, id: 31 });
      const data = m.prisma.regressionCase.update.mock.calls[0][0]
        .data as Record<string, unknown>;
      expect('baseline' in data).toBe(false);
      expect(data.tolerancePct).toBe(15); // dto undefined → existing
      expect(data.enabled).toBe(false);
    });

    it('update overrides tolerance/enabled/metricCode when provided', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      m.prisma.regressionCase.findFirst.mockResolvedValue(
        caseRow({ id: 31, tolerancePct: 15, enabled: false }),
      );
      await m.service.upsertCase(1, 8, {
        ...dto,
        id: 31,
        metricCode: ' pay_amt ',
        tolerancePct: 20,
        enabled: true,
      });
      expect(m.prisma.regressionCase.update).toHaveBeenCalledWith({
        where: { id: 31 },
        data: expect.objectContaining({
          metricCode: 'pay_amt',
          tolerancePct: 20,
          enabled: true,
        }),
      });
    });

    it('update resets the baseline when the question or datasource changes', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      const existing = caseRow({ id: 31 });
      m.prisma.regressionCase.findFirst
        .mockResolvedValueOnce(existing) // same q, different ds
        .mockResolvedValueOnce(existing) // different q
        .mockResolvedValue(null);
      await m.service.upsertCase(1, 8, { ...dto, id: 31, datasourceId: 6 });
      await m.service.upsertCase(1, 8, {
        ...dto,
        id: 31,
        question: '别的口径',
      });
      for (let i = 0; i < 2; i++) {
        const data = m.prisma.regressionCase.update.mock.calls[i][0]
          .data as Record<string, unknown>;
        expect(data.baseline).toBe(Prisma.DbNull);
      }
    });

    it('update rejects an unknown case id', async () => {
      const m = makeService();
      m.prisma.datasource.findFirst.mockResolvedValue({ id: 5 });
      m.prisma.regressionCase.findFirst.mockResolvedValue(null);
      await expect(
        m.service.upsertCase(1, 8, { ...dto, id: 404 }),
      ).rejects.toThrow('Regression case not found');
    });
  });

  describe('removeCase / setCaseEnabled', () => {
    it('removes an owned case', async () => {
      const m = makeService();
      m.prisma.regressionCase.findFirst.mockResolvedValue(caseRow());
      await m.service.removeCase(1, 11);
      expect(m.prisma.regressionCase.delete).toHaveBeenCalledWith({
        where: { id: 11 },
      });
    });

    it('remove rejects another workspace case', async () => {
      const m = makeService();
      m.prisma.regressionCase.findFirst.mockResolvedValue(null);
      await expect(m.service.removeCase(1, 11)).rejects.toThrow(
        'Regression case not found',
      );
      expect(m.prisma.regressionCase.delete).not.toHaveBeenCalled();
    });

    it('toggles a case enabled flag', async () => {
      const m = makeService();
      m.prisma.regressionCase.findFirst.mockResolvedValue(caseRow());
      await m.service.setCaseEnabled(1, 11, false);
      expect(m.prisma.regressionCase.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: { enabled: false },
      });
    });

    it('setEnabled rejects an unknown case', async () => {
      const m = makeService();
      m.prisma.regressionCase.findFirst.mockResolvedValue(null);
      await expect(m.service.setCaseEnabled(1, 11, true)).rejects.toThrow(
        'Regression case not found',
      );
    });
  });

  // --- run triggers --------------------------------------------------------

  describe('startApiRun', () => {
    const user = (id: number, oid = 1): CurrentUserInfo => ({
      id,
      account: `u${id}`,
      oid,
      language: 'en',
    });

    it('allows the global admin without any membership', async () => {
      const m = makeService();
      m.prisma.userWs.findFirst.mockResolvedValue(null);
      await m.service.startApiRun(user(1));
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: {
          oid: 1,
          trigger: 'api',
          triggerDetail: { actor_uid: 1 },
          status: 'running',
        },
      });
      await drainQueue(m.service, 1);
    });

    it('allows a workspace admin (weight != 0)', async () => {
      const m = makeService();
      m.prisma.userWs.findFirst.mockResolvedValue({ weight: 3 });
      await m.service.startApiRun(user(7));
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ trigger: 'api' }),
      });
      await drainQueue(m.service, 1);
    });

    it('forbids members and non-members', async () => {
      const m = makeService();
      m.prisma.userWs.findFirst.mockResolvedValueOnce({ weight: 0 });
      await expect(m.service.startApiRun(user(7))).rejects.toThrow(
        ForbiddenException,
      );
      m.prisma.userWs.findFirst.mockResolvedValueOnce(null);
      await expect(m.service.startApiRun(user(7))).rejects.toThrow(
        'Only workspace admins may trigger regression runs via API',
      );
      expect(m.prisma.regressionRun.create).not.toHaveBeenCalled();
    });
  });

  describe('startRun', () => {
    it('creates the run row without triggerDetail when detail is null', async () => {
      const m = makeService();
      const id = await m.service.startRun(1, 'manual', null);
      expect(id).toBe(501);
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: { oid: 1, trigger: 'manual', status: 'running' },
      });
      await drainQueue(m.service, 1); // background executeRun (run not found)
    });

    it('persists the trigger detail when provided', async () => {
      const m = makeService();
      await m.service.startRun(1, 'api', { actor_uid: 7 });
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: {
          oid: 1,
          trigger: 'api',
          triggerDetail: { actor_uid: 7 },
          status: 'running',
        },
      });
      await drainQueue(m.service, 1);
    });
  });

  // --- queueing ------------------------------------------------------------

  describe('enqueueRun (per-oid FIFO)', () => {
    it('serializes same-oid runs; other oids run independently', async () => {
      const m = makeService();
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      m.prisma.regressionRun.create
        .mockResolvedValueOnce({ id: 501 })
        .mockResolvedValueOnce({ id: 502 })
        .mockResolvedValueOnce({ id: 503 });
      // Run 501 parks on the gated lookup; 502/503 resolve immediately.
      m.prisma.regressionRun.findUnique
        .mockImplementationOnce(() => gate.then(() => null))
        .mockResolvedValue(null);

      await m.service.startRun(1, 'manual', null);
      await m.service.startRun(1, 'manual', null);
      await m.service.startRun(2, 'manual', null); // separate queue key

      await new Promise((resolve) => realSetTimeout(resolve, 20));
      const ids = m.prisma.regressionRun.findUnique.mock.calls.map(
        (c: Array<{ where: { id: number } }>) => c[0].where.id,
      );
      // 501 started (parked), 503 (oid 2) ran, but 502 waits behind 501.
      expect(ids).toEqual([501, 503]);

      releaseFirst();
      await drainQueue(m.service, 1);
      expect(
        m.prisma.regressionRun.findUnique.mock.calls.map(
          (c: Array<{ where: { id: number } }>) => c[0].where.id,
        ),
      ).toEqual([501, 503, 502]);
      // Settled tail run cleaned its queue entry up.
      expect(internals(m.service).queues.has(1)).toBe(false);
    });

    it('logs a crashed run without poisoning the queue', async () => {
      const m = makeService();
      m.prisma.regressionRun.create
        .mockResolvedValueOnce({ id: 501 })
        .mockResolvedValueOnce({ id: 502 });
      m.prisma.regressionRun.findUnique
        .mockRejectedValueOnce('kaboom') // non-Error → String(e) arm
        .mockResolvedValue(null);

      await m.service.startRun(1, 'manual', null);
      await m.service.startRun(1, 'manual', null);
      await drainQueue(m.service, 1);

      expect(m.loggerError).toHaveBeenCalledWith(
        'regression run #501 crashed: kaboom',
      );
      expect(
        m.prisma.regressionRun.findUnique.mock.calls.map(
          (c: Array<{ where: { id: number } }>) => c[0].where.id,
        ),
      ).toEqual([501, 502]);
    });
  });

  // --- execution -----------------------------------------------------------

  describe('executeRun', () => {
    it('returns silently when the run row is gone', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(null);
      await internals(m.service).executeRun(1, 501);
      expect(m.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(m.prisma.regressionRun.update).not.toHaveBeenCalled();
    });

    it('returns silently when the run is already terminal', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(
        runRow({ status: 'done' }),
      );
      await internals(m.service).executeRun(1, 501);
      expect(m.prisma.regressionRun.update).not.toHaveBeenCalled();
    });

    it('fails every case loudly when no run-as admin exists', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(runRow());
      m.prisma.user.findFirst.mockResolvedValue(null);
      m.prisma.regressionCase.findMany.mockResolvedValue([
        caseRow({ id: 11 }),
        caseRow({ id: 12 }),
      ]);
      m.prisma.regressionRunCase.groupBy.mockResolvedValue([
        { status: 'error', _count: { _all: 2 } },
      ]);

      await internals(m.service).executeRun(1, 501);

      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledTimes(2);
      for (const call of m.prisma.regressionRunCase.create.mock.calls) {
        expect(call[0].data).toMatchObject({
          runId: 501,
          status: 'error',
          message:
            'No enabled workspace admin to run the regression as — assign one and retry',
        });
      }
      expect(m.chatService.runPipeline).not.toHaveBeenCalled();
      expect(m.audit.record).not.toHaveBeenCalled();
      expect(m.prisma.regressionRun.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({
          status: 'done',
          errored: 2,
          passed: 0,
        }),
      });
    });

    it('runs cases in ONE regression ALS scope and finishes the run', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(runRow());
      m.prisma.user.findFirst.mockResolvedValue({
        id: 2,
        account: 'wsadmin',
        language: 'en',
        userWorkspaces: [{ oid: 1, weight: 2 }],
      });
      const caseNoBase = caseRow({ id: 11 });
      const caseWithBase = caseRow({
        id: 12,
        name: '订单量',
        question: '第二问',
        baseline: {
          rowCount: 100,
          sums: { amount: 1000 },
          sqlHash: 'h',
          capturedAt: '2026-01-01T00:00:00.000Z',
          runId: 500,
        },
      });
      m.prisma.regressionCase.findMany.mockResolvedValue([
        caseNoBase,
        caseWithBase,
      ]);
      m.prisma.datasource.findFirst.mockResolvedValue({
        id: 5,
        oid: 1,
        type: 'postgres',
      });
      let chatSeq = 900;
      m.prisma.chat.create.mockImplementation(() =>
        Promise.resolve({ id: chatSeq++ }),
      );
      let pipelineCtx: RequestContextData | undefined;
      m.chatService.runPipeline.mockImplementation(
        (_chatId: number, q: string) => {
          pipelineCtx = RequestContext.current();
          return asyncFrom(okEvents(77, q === '第二问' ? SQL : SQL));
        },
      );
      m.prisma.chatRecord.findUnique.mockResolvedValue({
        sqlExecResult: {
          columns: ['region', 'amount'],
          rows: [['north', 100]],
        },
      });
      m.datasourceService.execSql.mockResolvedValue({
        columns: ['__cnt', '__s0'],
        rows: [[100, 1000]],
      });
      m.prisma.regressionRunCase.groupBy.mockResolvedValue([
        { status: 'baseline_captured', _count: { _all: 1 } },
        { status: 'passed', _count: { _all: 1 } },
      ]);

      await internals(m.service).executeRun(1, 501);

      // ONE ALS scope for the whole run: run-as user + regression agent.
      expect(pipelineCtx?.user?.id).toBe(2);
      expect(pipelineCtx?.agent).toEqual({ type: 'regression' });
      expect(pipelineCtx?.acceptLanguage).toBe('en');
      expect(m.chatService.start).not.toHaveBeenCalled(); // direct chat.create
      const chatData = m.prisma.chat.create.mock.calls[0][0].data;
      expect(chatData).toMatchObject({
        oid: 1,
        createBy: 2,
        datasourceId: 5,
        engineType: 'PostgreSQL',
        title: '回归 · 支付金额',
        origin: 2, // regression sentinel
        recommendedQuestion: [],
      });
      expect(m.chatService.runPipeline).toHaveBeenCalledWith(
        900,
        '近7天支付金额',
      );
      // Verify SQL wraps the LLM SQL in DB-side COUNT/SUM (LIMIT stripped).
      expect(m.datasourceService.execSql).toHaveBeenCalledWith(
        5,
        buildVerifySql(SQL, ['amount'], 'postgres'),
      );
      // First run of case 11 captures the baseline.
      expect(m.prisma.regressionCase.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: {
          baseline: {
            rowCount: 100,
            sums: { amount: 1000 },
            sqlHash: sqlTextHash(SQL),
            capturedAt: expect.any(String),
            runId: 501,
          },
        },
      });
      const statuses = m.prisma.regressionRunCase.create.mock.calls.map(
        (c: Array<{ data: { status: string } }>) => c[0].data.status,
      );
      expect(statuses).toEqual(['baseline_captured', 'passed']);
      expect(m.prisma.regressionRun.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({
          status: 'done',
          passed: 2,
          flagged: 0,
          errored: 0,
          finishedAt: expect.any(Date),
        }),
      });
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          module: OperationModule.REGRESSION,
          type: OperationType.SYNC,
          status: 'success',
          resources: [{ name: 'regression_run', originId: 501 }],
        }),
      );
      // The transient regression chats are cleaned up in the finally.
      expect(m.prisma.chat.delete).toHaveBeenCalledWith({ where: { id: 900 } });
      expect(m.prisma.chat.delete).toHaveBeenCalledWith({ where: { id: 901 } });
    });

    it('isolates a case crash outside runCase (chat.create) and keeps going', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(runRow());
      m.prisma.user.findFirst.mockResolvedValue({
        id: 2,
        account: 'wsadmin',
        language: 'en',
        userWorkspaces: [{ oid: 1, weight: 2 }],
      });
      m.prisma.regressionCase.findMany.mockResolvedValue([
        caseRow({ id: 11 }),
        caseRow({ id: 12, name: '第二问', question: '第二问' }),
      ]);
      m.prisma.datasource.findFirst.mockResolvedValue({
        id: 5,
        oid: 1,
        type: 'postgres',
      });
      m.prisma.chat.create
        .mockRejectedValueOnce('chat create boom') // non-Error → String(e) arm
        .mockResolvedValueOnce({ id: 901 });
      m.chatService.runPipeline.mockImplementation(() => asyncFrom(okEvents()));
      // The crash-path snapshot write ALSO fails — the run must survive anyway
      // (writeRunCase rejection is swallowed by executeRun's catch).
      m.prisma.regressionRunCase.create
        .mockRejectedValueOnce(new Error('write boom'))
        .mockResolvedValue({ id: 1 });
      m.prisma.chatRecord.findUnique.mockResolvedValue(null);
      m.datasourceService.execSql.mockResolvedValue({
        columns: ['__cnt'],
        rows: [[100]],
      });
      m.prisma.regressionRunCase.groupBy.mockResolvedValue([]);

      await internals(m.service).executeRun(1, 501);

      expect(m.loggerError).toHaveBeenCalledWith(
        'regression case #11 crashed: chat create boom',
      );
      // Case 12 still ran end-to-end (baseline captured, no sample sums).
      const lastCreate = m.prisma.regressionRunCase.create.mock.calls.at(-1);
      expect(lastCreate[0].data).toMatchObject({
        runId: 501,
        caseId: 12,
        status: 'baseline_captured',
      });
      expect(m.prisma.regressionRun.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({ status: 'done' }),
      });
    });

    it('marks the run terminal even when the pre-loop phase aborts', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(runRow());
      m.prisma.user.findFirst.mockRejectedValue('db down'); // non-Error throw
      m.prisma.regressionRunCase.groupBy.mockResolvedValue([]);

      await internals(m.service).executeRun(1, 501);

      expect(m.loggerError).toHaveBeenCalledWith(
        'regression run #501 aborted: db down',
      );
      expect(m.prisma.regressionRun.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({ status: 'done' }),
      });
    });

    it('survives a finishRun failure (logged, run stays running)', async () => {
      const m = makeService();
      m.prisma.regressionRun.findUnique.mockResolvedValue(runRow());
      m.prisma.user.findFirst.mockResolvedValue({
        id: 2,
        account: 'wsadmin',
        language: 'en',
        userWorkspaces: [{ oid: 1, weight: 2 }],
      });
      m.prisma.regressionCase.findMany.mockResolvedValue([]); // no cases
      m.prisma.regressionRunCase.groupBy.mockRejectedValue('grp down');
      // An audit failure is fire-and-forget swallowed, never fatal.
      m.audit.record.mockRejectedValueOnce(new Error('audit down'));

      await internals(m.service).executeRun(1, 501);

      expect(m.loggerError).toHaveBeenCalledWith(
        'regression run #501 finish failed: grp down',
      );
      expect(m.audit.record).toHaveBeenCalled();
    });
  });

  // --- runCase (one case end-to-end) ---------------------------------------

  describe('runCase', () => {
    let m: ReturnType<typeof makeService>;
    beforeEach(() => {
      m = makeService();
      wireHappyPipeline(m);
    });

    it('errors the case when the datasource vanished', async () => {
      m.prisma.datasource.findFirst.mockResolvedValue(null);
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      expect(m.prisma.chat.create).not.toHaveBeenCalled();
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          runId: 501,
          caseId: 11,
          status: 'error',
          message: 'The datasource does not exist in this workspace',
        }),
      });
    });

    it('records needs_clarify when the pipeline paused with a question', async () => {
      m.chatService.runPipeline.mockImplementation(() =>
        asyncFrom<ChatSseEvent>([
          { type: 'id', data: { id: 55 } },
          {
            type: 'clarify',
            data: {
              record_id: 55,
              round: 1,
              question: '哪个数据源?',
              candidates: [],
              max_select: 3,
            },
          },
          { type: 'finish', data: {} },
        ]),
      );
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      expect(m.datasourceService.execSql).not.toHaveBeenCalled();
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: {
          runId: 501,
          caseId: 11,
          status: 'needs_clarify',
          sql: null,
          rowCount: null,
          recordId: 55,
          message:
            'The case question triggers a clarification pause — make the question more specific',
        },
      });
      // The chat is still cleaned up.
      expect(m.prisma.chat.delete).toHaveBeenCalledWith({ where: { id: 900 } });
    });

    it('records the pipeline error verbatim', async () => {
      m.chatService.runPipeline.mockImplementation(() =>
        asyncFrom<ChatSseEvent>([
          { type: 'error', data: { content: 'LLM down' } },
        ]),
      );
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: {
          runId: 501,
          caseId: 11,
          status: 'error',
          sql: null,
          rowCount: null,
          recordId: null,
          message: 'LLM down',
        },
      });
    });

    it('records sql_missing when the stream produced no SQL and no error', async () => {
      m.chatService.runPipeline.mockImplementation(() =>
        asyncFrom<ChatSseEvent>([
          { type: 'id', data: { id: 77 } },
          { type: 'finish', data: {} },
        ]),
      );
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'error',
          recordId: 77,
          message: 'The pipeline produced no SQL',
        }),
      });
    });

    it('captures the baseline on the first run (with sums from the sample)', async () => {
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      // Baseline write is atomic with the run-case snapshot.
      expect(m.prisma.$transaction).toHaveBeenCalledTimes(1);
      const createData =
        m.prisma.regressionRunCase.create.mock.calls[0][0].data;
      expect(createData).toEqual({
        runId: 501,
        caseId: 11,
        status: 'baseline_captured',
        sql: SQL,
        rowCount: 100,
        sums: { amount: 1000 },
        recordId: 77,
        message: 'First run — baseline captured, comparison starts next run',
      });
      expect(m.prisma.regressionCase.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: {
          baseline: {
            rowCount: 100,
            sums: { amount: 1000 },
            sqlHash: sqlTextHash(SQL),
            capturedAt: expect.any(String),
            runId: 501,
          },
        },
      });
    });

    it('compares against the baseline and passes within tolerance', async () => {
      const c = caseRow({
        baseline: {
          rowCount: 100,
          sums: { amount: 1000 },
          sqlHash: 'h',
          capturedAt: '2026-01-01T00:00:00.000Z',
          runId: 500,
        },
      });
      await internals(m.service).runCase(ACTOR, 501, c);
      expect(m.prisma.regressionCase.update).not.toHaveBeenCalled();
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: {
          runId: 501,
          caseId: 11,
          status: 'passed',
          sql: SQL,
          rowCount: 100,
          sums: { amount: 1000 },
          delta: expect.objectContaining({ reasons: [], rowCountPct: 0 }),
          recordId: 77,
          message: null,
        },
      });
    });

    it('flags row-count inflation beyond tolerance', async () => {
      const c = caseRow({
        baseline: {
          rowCount: 100,
          sums: { amount: 1000 },
          sqlHash: 'h',
          capturedAt: '2026-01-01T00:00:00.000Z',
          runId: 500,
        },
      });
      m.datasourceService.execSql.mockResolvedValue({
        columns: ['__cnt', '__s0'],
        rows: [[250, 1000]],
      });
      await internals(m.service).runCase(ACTOR, 501, c);
      const data = m.prisma.regressionRunCase.create.mock.calls[0][0].data;
      expect(data.status).toBe('flagged');
      expect(data.delta.reasons).toEqual(['row_count_inflated']);
      expect(data.rowCount).toBe(250);
    });

    it('degrades to row-count comparison when the SUM probe fails', async () => {
      const c = caseRow({
        baseline: {
          rowCount: 100,
          sums: { amount: 1000 },
          sqlHash: 'h',
          capturedAt: '2026-01-01T00:00:00.000Z',
          runId: 500,
        },
      });
      m.datasourceService.execSql
        .mockRejectedValueOnce('SUM(text) fails') // non-Error → String(e) arm
        .mockResolvedValueOnce({ columns: ['__cnt'], rows: [[100]] });
      await internals(m.service).runCase(ACTOR, 501, c);
      expect(m.loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('falling back to row count'),
      );
      // Retry without the SUM projections.
      expect(m.datasourceService.execSql).toHaveBeenNthCalledWith(
        2,
        5,
        buildVerifySql(SQL, [], 'postgres'),
      );
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          // The baseline still HAS sums, so the degraded run stays loud
          // (schema_changed via missingColumns) — documented policy behavior.
          status: 'flagged',
          rowCount: 100,
          sums: {},
          delta: expect.objectContaining({
            reasons: ['schema_changed'],
            missingColumns: ['amount'],
          }),
          message:
            'Numeric SUM probe failed — this case is compared by row count only',
        }),
      });
    });

    it('captures a sumsUnavailable baseline when the first run degrades', async () => {
      m.datasourceService.execSql
        .mockRejectedValueOnce(new Error('SUM(text) fails'))
        .mockResolvedValueOnce({ columns: ['__cnt'], rows: [[100]] });
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      const createData =
        m.prisma.regressionRunCase.create.mock.calls[0][0].data;
      expect(createData.status).toBe('baseline_captured');
      expect(createData.message).toBe(
        'Numeric SUM probe failed — this case is compared by row count only',
      );
      const updateData = m.prisma.regressionCase.update.mock.calls[0][0].data;
      expect(updateData.baseline).toMatchObject({
        rowCount: 100,
        sumsUnavailable: true,
      });
    });

    it('rethrows (→ error row) when the verify query fails without sums', async () => {
      // No recordId → no sample → numericCols [] → the catch rethrows.
      m.chatService.runPipeline.mockImplementation(() =>
        asyncFrom<ChatSseEvent>([
          { type: 'sql', data: { content: SQL } },
          { type: 'finish', data: {} },
        ]),
      );
      m.datasourceService.execSql.mockRejectedValue(new Error('verify boom'));
      m.prisma.chat.delete.mockRejectedValue(new Error('chat gone'));
      await internals(m.service).runCase(ACTOR, 501, caseRow());
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'error',
          message: 'verify boom',
        }),
      });
      // The chat-deletion failure in the finally is swallowed.
      expect(m.prisma.chat.delete).toHaveBeenCalledWith({ where: { id: 900 } });
    });

    it('never throws even when the snapshot write also fails', async () => {
      m.chatService.runPipeline.mockImplementation(() => {
        // Deliberate non-Error throw to pin the String(e) arm of runCase's
        // crash snapshot (mockRejectedValue would not reach it).
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'pipeline exploded';
      });
      m.prisma.regressionRunCase.create.mockRejectedValue(
        new Error('write boom'),
      );
      await expect(
        internals(m.service).runCase(ACTOR, 501, caseRow()),
      ).resolves.toBeUndefined();
      expect(m.prisma.regressionRunCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'error',
          message: 'pipeline exploded',
        }),
      });
    });
  });

  // --- finish / actor ------------------------------------------------------

  describe('finishRun', () => {
    it('folds every status bucket into the run counters', async () => {
      const m = makeService();
      m.prisma.regressionRunCase.groupBy.mockResolvedValue([
        { status: 'passed', _count: { _all: 2 } },
        { status: 'baseline_captured', _count: { _all: 1 } },
        { status: 'flagged', _count: { _all: 1 } },
        { status: 'error', _count: { _all: 1 } },
        { status: 'needs_clarify', _count: { _all: 2 } },
      ]);
      await internals(m.service).finishRun(501);
      expect(m.prisma.regressionRunCase.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: { runId: 501 },
        _count: { _all: true },
      });
      expect(m.prisma.regressionRun.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: expect.objectContaining({
          status: 'done',
          passed: 3, // passed + baseline_captured
          flagged: 1,
          errored: 3, // error + needs_clarify
          finishedAt: expect.any(Date),
        }),
      });
    });
  });

  describe('resolveActor', () => {
    it('returns null when no admin exists', async () => {
      const m = makeService();
      m.prisma.user.findFirst.mockResolvedValue(null);
      expect(await internals(m.service).resolveActor(1)).toBeNull();
    });

    it('picks the membership weight of a workspace admin', async () => {
      const m = makeService();
      m.prisma.user.findFirst.mockResolvedValue({
        id: 2,
        account: 'wsadmin',
        language: 'zh-CN',
        userWorkspaces: [
          { oid: 9, weight: 5 },
          { oid: 1, weight: 2 },
        ],
      });
      expect(await internals(m.service).resolveActor(1)).toEqual({
        id: 2,
        account: 'wsadmin',
        oid: 1,
        language: 'zh-CN',
        weight: 2,
      });
    });

    it('falls back to weight 1 for the global admin without membership', async () => {
      const m = makeService();
      m.prisma.user.findFirst.mockResolvedValue({
        id: 1,
        account: 'root',
        language: 'en',
        userWorkspaces: [],
      });
      expect(await internals(m.service).resolveActor(5)).toEqual({
        id: 1,
        account: 'root',
        oid: 5,
        language: 'en',
        weight: 1,
      });
    });

    it('surfaces weight 0 for a matched user without this membership', async () => {
      const m = makeService();
      m.prisma.user.findFirst.mockResolvedValue({
        id: 7,
        account: 'drifter',
        language: 'en',
        userWorkspaces: [],
      });
      expect(await internals(m.service).resolveActor(5)).toMatchObject({
        id: 7,
        oid: 5,
        weight: 0,
      });
    });
  });

  // --- runs listing / promote ---------------------------------------------

  describe('listRuns / runDetail', () => {
    it('pages runs newest-first', async () => {
      const m = makeService();
      m.prisma.regressionRun.findMany.mockResolvedValue([runRow()]);
      m.prisma.regressionRun.count.mockResolvedValue(7);
      const res = await m.service.listRuns(1, 2, 5);
      expect(res).toEqual({ rows: [runRow()], total: 7 });
      expect(m.prisma.regressionRun.findMany).toHaveBeenCalledWith({
        where: { oid: 1 },
        orderBy: { id: 'desc' },
        skip: 5,
        take: 5,
      });
    });

    it('runDetail returns the run plus ordered per-case diffs', async () => {
      const m = makeService();
      m.prisma.regressionRun.findFirst.mockResolvedValue(runRow());
      m.prisma.regressionRunCase.findMany.mockResolvedValue([
        { caseId: 11, status: 'passed' },
      ]);
      const res = await m.service.runDetail(1, 501);
      expect(res.run.id).toBe(501);
      expect(m.prisma.regressionRunCase.findMany).toHaveBeenCalledWith({
        where: { runId: 501 },
        orderBy: { caseId: 'asc' },
        include: { case: { select: { name: true, question: true } } },
      });
    });

    it('runDetail 404s for another workspace run', async () => {
      const m = makeService();
      m.prisma.regressionRun.findFirst.mockResolvedValue(null);
      await expect(m.service.runDetail(1, 501)).rejects.toThrow(
        'Regression run not found',
      );
    });
  });

  describe('promote', () => {
    const startedAt = new Date('2026-01-02T00:00:00Z');

    it('404s for an unknown run', async () => {
      const m = makeService();
      m.prisma.regressionRun.findFirst.mockResolvedValue(null);
      await expect(m.service.promote(1, 501)).rejects.toThrow(
        'Regression run not found',
      );
    });

    it('rejects a run that is not finished', async () => {
      const m = makeService();
      m.prisma.regressionRun.findFirst.mockResolvedValue(
        runRow({ status: 'running' }),
      );
      await expect(m.service.promote(1, 501)).rejects.toThrow(
        'Only finished runs can be promoted',
      );
    });

    it('adopts fresh rows and skips cases edited after the run started', async () => {
      const m = makeService();
      m.prisma.regressionRun.findFirst.mockResolvedValue(
        runRow({ status: 'done', startedAt }),
      );
      m.prisma.regressionRunCase.findMany.mockResolvedValue([
        {
          caseId: 11,
          status: 'passed',
          rowCount: 100,
          sums: { amount: 1000 },
          sql: 'SELECT 1',
          case: { updatedAt: new Date('2026-01-01T00:00:00Z') },
        },
        {
          caseId: 12,
          status: 'flagged',
          rowCount: null, // → 0
          sums: null, // → {}
          sql: null, // → ''
          case: { updatedAt: startedAt }, // == startedAt → still promotable
        },
        {
          caseId: 13,
          status: 'passed',
          rowCount: 5,
          sums: {},
          sql: 'SELECT 2',
          case: { updatedAt: new Date('2026-01-03T00:00:00Z') }, // stale
        },
      ]);

      const res = await m.service.promote(1, 501);

      expect(res).toEqual({ promoted: 2, skipped: 1 });
      expect(m.prisma.regressionCase.update).toHaveBeenCalledTimes(2);
      expect(m.prisma.regressionCase.update).toHaveBeenNthCalledWith(1, {
        where: { id: 11 },
        data: {
          baseline: {
            rowCount: 100,
            sums: { amount: 1000 },
            sqlHash: sqlTextHash('SELECT 1'),
            capturedAt: expect.any(String),
            runId: 501,
          },
        },
      });
      expect(m.prisma.regressionCase.update).toHaveBeenNthCalledWith(2, {
        where: { id: 12 },
        data: {
          baseline: {
            rowCount: 0,
            sums: {},
            sqlHash: '',
            capturedAt: expect.any(String),
            runId: 501,
          },
        },
      });
    });
  });

  // --- approval debounce ---------------------------------------------------

  describe('handleApproval (30s debounce, via the registered launcher)', () => {
    function armedLauncher(
      m: ReturnType<typeof makeService>,
    ): RegressionRunLauncher {
      m.service.onModuleInit();
      return m.trigger.registerRunner.mock.calls[0][0] as RegressionRunLauncher;
    }

    it('coalesces a burst into ONE run with merged entity types + latest detail', async () => {
      const m = makeService();
      const launcher = armedLauncher(m);
      m.prisma.regressionRun.create.mockResolvedValue({ id: 900 });

      jest.useFakeTimers();
      launcher(1, 'semantic', { requestId: 'a' });
      launcher(1, 'metric', { requestId: 'b' });
      launcher(1, 'semantic', { requestId: 'c' }); // duplicate type ignored
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);

      expect(m.prisma.regressionRun.create).toHaveBeenCalledTimes(1);
      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          oid: 1,
          trigger: 'approval',
          triggerDetail: {
            entity_types: ['semantic', 'metric'],
            requestId: 'c', // latest detail wins
          },
        }),
      });
    });

    it('re-arms after a window fired: a later approval schedules a new run', async () => {
      const m = makeService();
      const launcher = armedLauncher(m);
      m.prisma.regressionRun.create.mockResolvedValue({ id: 900 });

      jest.useFakeTimers();
      launcher(1, 'semantic', { requestId: 'a' });
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);
      launcher(1, 'metric', { requestId: 'b' });
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);

      expect(m.prisma.regressionRun.create).toHaveBeenCalledTimes(2);
    });

    it('keeps workspaces independent (per-oid debounce state)', async () => {
      const m = makeService();
      const launcher = armedLauncher(m);
      m.prisma.regressionRun.create.mockResolvedValue({ id: 900 });

      jest.useFakeTimers();
      launcher(1, 'semantic', {});
      launcher(2, 'semantic', {});
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);
      await drainQueue(m.service, 2);

      expect(m.prisma.regressionRun.create).toHaveBeenCalledTimes(2);
      expect(m.prisma.regressionRun.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ data: expect.objectContaining({ oid: 1 }) }),
      );
      expect(m.prisma.regressionRun.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: expect.objectContaining({ oid: 2 }) }),
      );
    });

    it('falls back to the triggering detail when the payload vanished', async () => {
      const m = makeService();
      const launcher = armedLauncher(m);
      m.prisma.regressionRun.create.mockResolvedValue({ id: 900 });

      jest.useFakeTimers();
      launcher(1, 'metric', { x: 1 });
      internals(m.service).approvalPayload.clear(); // defensive-branch probe
      await jest.advanceTimersByTimeAsync(31_000);
      await drainQueue(m.service, 1);

      expect(m.prisma.regressionRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          triggerDetail: expect.objectContaining({
            entity_types: ['metric'],
            x: 1,
          }),
        }),
      });
    });

    it('logs (not throws) when the run row cannot be created', async () => {
      const m = makeService();
      const launcher = armedLauncher(m);
      m.prisma.regressionRun.create.mockRejectedValue('db down'); // non-Error

      jest.useFakeTimers();
      launcher(1, 'semantic', {});
      await jest.advanceTimersByTimeAsync(31_000);
      await Promise.resolve(); // flush the rejection → logger.error

      expect(m.loggerError).toHaveBeenCalledWith(
        'approval regression run create failed (oid=1): db down',
      );
    });
  });
});
