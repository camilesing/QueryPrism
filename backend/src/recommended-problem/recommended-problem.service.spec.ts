// recommended-problem.service spec — verifies the 3-route contract
// (list/base/save). Mocks PrismaService; the controller layer applies the
// snake-mapper.
// RequestContext.getUser() reads the AsyncLocalStorage store; the `withUser`
// helper establishes it for a test without spinning up the Nest middleware.
import { requestContextStorage } from '../common/context/request-context';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import {
  RecommendedProblemService,
  type RecommendedProblemSaveBody,
} from './recommended-problem.service';

function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

/** Run every service call inside a request context (workspace 1). */
function withContext<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        withUser(1, () =>
          (value as (...a: unknown[]) => Promise<unknown>).apply(t, args),
        );
    },
  });
}

type MockPrisma = {
  $transaction: jest.Mock;
  datasource: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  dsRecommendedProblem: {
    findMany: jest.Mock;
    deleteMany: jest.Mock;
    createMany: jest.Mock;
  };
};

function makePrisma(): MockPrisma {
  const prisma = {
    datasource: {
      // The default datasource belongs to the current workspace; tests that
      // exercise the "not found" branch override this with null.
      findFirst: jest.fn().mockResolvedValue({ id: 10 }),
      update: jest.fn(),
    },
    dsRecommendedProblem: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  } as unknown as MockPrisma;
  prisma.$transaction = jest.fn((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (client: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return prisma;
}

describe('RecommendedProblemService', () => {
  let prisma: MockPrisma;
  let service: RecommendedProblemService;

  beforeEach(async () => {
    prisma = makePrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecommendedProblemService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = withContext(moduleRef.get(RecommendedProblemService));
  });

  // ─────────────────────── listByDatasource ───────────────────────

  describe('listByDatasource', () => {
    it('returns bare array of snake-mapped rows (datasourceId-scoped, orderBy createdAt asc)', async () => {
      prisma.dsRecommendedProblem.findMany.mockResolvedValue([
        {
          id: 1,
          datasourceId: 10,
          question: 'q1',
          createdAt: new Date('2026-07-26T00:00:00Z'),
        },
        {
          id: 2,
          datasourceId: 10,
          question: 'q2',
          createdAt: new Date('2026-07-26T01:00:00Z'),
        },
      ]);
      const out = await service.listByDatasource(10);
      expect(prisma.dsRecommendedProblem.findMany).toHaveBeenCalledWith({
        where: { datasourceId: 10 },
        orderBy: { createdAt: 'asc' },
      });
      expect(out).toEqual([
        { id: 1, datasource_id: 10, question: 'q1' },
        { id: 2, datasource_id: 10, question: 'q2' },
      ]);
      expect(Array.isArray(out)).toBe(true); // bare array, NOT {items,total}
    });

    it('returns [] when no rows for the datasource', async () => {
      prisma.dsRecommendedProblem.findMany.mockResolvedValue([]);
      const out = await service.listByDatasource(99);
      expect(out).toEqual([]);
    });
  });

  // ─────────────────────────── getBase ───────────────────────────

  describe('getBase', () => {
    it('returns {datasource_id, recommended_config:0, questions:null} when datasource not found', async () => {
      prisma.datasource.findFirst.mockResolvedValue(null);
      const out = await service.getBase(404);
      expect(prisma.datasource.findFirst).toHaveBeenCalledWith({
        where: { id: 404, oid: 1 },
      });
      expect(out).toEqual({
        datasource_id: 404,
        recommended_config: 0,
        questions: null,
      });
    });

    it('returns {dsId, 1, null} when recommended_config=1 (AI auto — no questions fetched)', async () => {
      prisma.datasource.findFirst.mockResolvedValue({
        id: 10,
        recommendedConfig: 1,
      });
      const out = await service.getBase(10);
      expect(out).toEqual({
        datasource_id: 10,
        recommended_config: 1,
        questions: null,
      });
      expect(prisma.dsRecommendedProblem.findMany).not.toHaveBeenCalled();
    });

    it('returns {dsId, 2, JSON.stringify(questions)} when recommended_config=2', async () => {
      prisma.datasource.findFirst.mockResolvedValue({
        id: 10,
        recommendedConfig: 2,
      });
      prisma.dsRecommendedProblem.findMany.mockResolvedValue([
        { question: 'q1' },
        { question: 'q2' },
      ]);
      const out = await service.getBase(10);
      expect(prisma.dsRecommendedProblem.findMany).toHaveBeenCalledWith({
        where: { datasourceId: 10 },
        orderBy: { createdAt: 'asc' },
        select: { question: true },
      });
      expect(out).toEqual({
        datasource_id: 10,
        recommended_config: 2,
        questions: JSON.stringify(['q1', 'q2']),
      });
    });

    it('coerces Json recommendedConfig → number; null/missing → 0', async () => {
      prisma.datasource.findFirst.mockResolvedValue({
        id: 10,
        recommendedConfig: null,
      });
      const out = await service.getBase(10);
      expect(out.recommended_config).toBe(0);
      expect(out.questions).toBeNull();
    });
  });

  // ─────────────────────────── save ───────────────────────────

  describe('save', () => {
    const body: RecommendedProblemSaveBody = {
      recommended_config: 2,
      datasource_id: 10,
      problemInfo: [{ question: 'q1' }, { question: 'q2' }, { question: 'q3' }],
    };

    it('updates Datasource.recommendedConfig + deleteMany + createMany (replace-all)', async () => {
      const out = await withUser(1, () => service.save(body));
      // Datasource.recommendedConfig updated to body.recommended_config
      expect(prisma.datasource.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { recommendedConfig: 2 },
      });
      // old rows deleted (replace-all)
      expect(prisma.dsRecommendedProblem.deleteMany).toHaveBeenCalledWith({
        where: { datasourceId: 10 },
      });
      // new rows batch-created (datasourceId + question only; client id/sort ignored)
      expect(prisma.dsRecommendedProblem.createMany).toHaveBeenCalledWith({
        data: [
          { datasourceId: 10, question: 'q1' },
          { datasourceId: 10, question: 'q2' },
          { datasourceId: 10, question: 'q3' },
        ],
      });
      expect(out).toEqual({
        datasource_id: 10,
        recommended_config: 2,
        count: 3,
      });
    });

    it('handles empty problemInfo (config=1, AI auto — no user problems)', async () => {
      const out = await withUser(1, () =>
        service.save({
          recommended_config: 1,
          datasource_id: 10,
          problemInfo: [],
        }),
      );
      expect(prisma.dsRecommendedProblem.deleteMany).toHaveBeenCalledWith({
        where: { datasourceId: 10 },
      });
      // Empty replace-all skips createMany (Prisma rejects empty data arrays).
      expect(prisma.dsRecommendedProblem.createMany).not.toHaveBeenCalled();
      expect(out).toEqual({
        datasource_id: 10,
        recommended_config: 1,
        count: 0,
      });
    });

    it('ignores client-sent id + sort (regenerated/absent)', async () => {
      await withUser(1, () =>
        service.save({
          recommended_config: 2,
          datasource_id: 7,
          problemInfo: [
            { id: 999, question: 'q1', sort: 5 } as any,
            { question: 'q2' },
          ],
        }),
      );
      const call = prisma.dsRecommendedProblem.createMany.mock.calls[0][0];
      expect(call.data).toEqual([
        { datasourceId: 7, question: 'q1' }, // id=999 + sort=5 stripped
        { datasourceId: 7, question: 'q2' },
      ]);
    });
  });
});
