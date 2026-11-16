// QueryCacheService spec (M7 SQL result cache). Verifies:
//   - currentRevision: 0 for a missing row; number value passthrough; numeric
//     string parsed; non-numeric/object values degrade to 0.
//   - bumpRevision: upsert create (first bump) vs update (existing rev).
//   - lookup: miss / revision-mismatch / TTL-expired → null; fresh hit → result.
//   - store: upsert payload + lazy purge; a store failure is logged and
//     swallowed (best-effort — the caller already holds the fresh result).
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { QueryCacheService } from './query-cache.service';
import type { QueryResult } from '../datasource/db-connector/db-connector.interface';

describe('QueryCacheService', () => {
  let service: QueryCacheService;
  let prisma: {
    systemVariable: { findUnique: jest.Mock; upsert: jest.Mock };
    queryCacheEntry: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      systemVariable: { findUnique: jest.fn(), upsert: jest.fn() },
      queryCacheEntry: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        QueryCacheService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(QueryCacheService);
  });

  describe('currentRevision', () => {
    it('reads the per-workspace cache_rev SystemVariable row', async () => {
      prisma.systemVariable.findUnique.mockResolvedValue({ value: 7 });
      await expect(service.currentRevision(3)).resolves.toBe(7);
      expect(prisma.systemVariable.findUnique).toHaveBeenCalledWith({
        where: { name: 'cache.rev.3' },
      });
    });

    it('returns 0 when the workspace never bumped a revision', async () => {
      prisma.systemVariable.findUnique.mockResolvedValue(null);
      await expect(service.currentRevision(1)).resolves.toBe(0);
    });

    it('parses a numeric string revision', async () => {
      prisma.systemVariable.findUnique.mockResolvedValue({ value: '12' });
      await expect(service.currentRevision(1)).resolves.toBe(12);
    });

    it('degrades non-numeric strings and non-scalar values to 0', async () => {
      prisma.systemVariable.findUnique.mockResolvedValueOnce({ value: 'abc' });
      await expect(service.currentRevision(1)).resolves.toBe(0);
      prisma.systemVariable.findUnique.mockResolvedValueOnce({ value: [1] });
      await expect(service.currentRevision(1)).resolves.toBe(0);
    });
  });

  describe('bumpRevision', () => {
    it('first bump creates the sentinel row with value 1', async () => {
      prisma.systemVariable.findUnique.mockResolvedValue(null);
      await service.bumpRevision(5);
      expect(prisma.systemVariable.upsert).toHaveBeenCalledWith({
        where: { name: 'cache.rev.5' },
        create: expect.objectContaining({
          name: 'cache.rev.5',
          varType: 'number',
          type: 'cache_rev',
          value: 1,
        }),
        update: { value: 1 },
      });
    });

    it('subsequent bumps update to current + 1', async () => {
      prisma.systemVariable.findUnique.mockResolvedValue({ value: 7 });
      await service.bumpRevision(5);
      expect(prisma.systemVariable.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: 8 } }),
      );
    });
  });

  describe('lookup', () => {
    const result: QueryResult = { columns: ['a'], rows: [[1]] };

    it('returns the stored result on a fresh hit at the current revision', async () => {
      prisma.queryCacheEntry.findUnique.mockResolvedValue({
        revision: 3,
        expiresAt: new Date(Date.now() + 60_000),
        result,
      });
      await expect(service.lookup(1, 2, 'hash', 3)).resolves.toEqual(result);
      expect(prisma.queryCacheEntry.findUnique).toHaveBeenCalledWith({
        where: {
          oid_datasourceId_sqlHash: {
            oid: 1,
            datasourceId: 2,
            sqlHash: 'hash',
          },
        },
      });
    });

    it('misses when no row exists', async () => {
      prisma.queryCacheEntry.findUnique.mockResolvedValue(null);
      await expect(service.lookup(1, 2, 'hash', 3)).resolves.toBeNull();
    });

    it('misses when the row belongs to an older revision', async () => {
      prisma.queryCacheEntry.findUnique.mockResolvedValue({
        revision: 2,
        expiresAt: new Date(Date.now() + 60_000),
        result,
      });
      await expect(service.lookup(1, 2, 'hash', 3)).resolves.toBeNull();
    });

    it('misses when the TTL has expired (expiresAt <= now)', async () => {
      prisma.queryCacheEntry.findUnique.mockResolvedValue({
        revision: 3,
        expiresAt: new Date(Date.now() - 1),
        result,
      });
      await expect(service.lookup(1, 2, 'hash', 3)).resolves.toBeNull();
    });
  });

  describe('store', () => {
    it('upserts the entry and lazily purges expired rows of the workspace', async () => {
      const payload: QueryResult = { columns: ['a', 'b'], rows: [[1, 2]] };
      await service.store(1, 2, 'hash', 'SELECT 1', payload, 9, 60);
      expect(prisma.queryCacheEntry.upsert).toHaveBeenCalledWith({
        where: {
          oid_datasourceId_sqlHash: {
            oid: 1,
            datasourceId: 2,
            sqlHash: 'hash',
          },
        },
        create: expect.objectContaining({
          oid: 1,
          datasourceId: 2,
          sqlHash: 'hash',
          sql: 'SELECT 1',
          result: { columns: ['a', 'b'], rows: [[1, 2]] },
          rowCount: 1,
          revision: 9,
          expiresAt: expect.any(Date),
        }),
        update: expect.objectContaining({ revision: 9, rowCount: 1 }),
      });
      expect(prisma.queryCacheEntry.deleteMany).toHaveBeenCalledWith({
        where: { oid: 1, expiresAt: { lt: expect.any(Date) } },
      });
    });

    it('swallows a store failure (best-effort, caller keeps the fresh result)', async () => {
      prisma.queryCacheEntry.upsert.mockRejectedValue(
        new Error('cache table gone'),
      );
      await expect(
        service.store(
          1,
          2,
          'hash',
          'SELECT 1',
          { columns: [], rows: [] },
          1,
          60,
        ),
      ).resolves.toBeUndefined();
      // the piggybacked purge never ran (same try block)
      expect(prisma.queryCacheEntry.deleteMany).not.toHaveBeenCalled();
    });
  });
});

describe('QueryCacheService store (non-Error failure shape)', () => {
  it('stringifies a non-Error rejection without throwing', async () => {
    const prisma = {
      systemVariable: { findUnique: jest.fn(), upsert: jest.fn() },
      queryCacheEntry: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockRejectedValue('plain string'),
        deleteMany: jest.fn(),
      },
    };
    // direct construction — the service only needs the prisma delegate
    const svc = new QueryCacheService(prisma as never);
    await expect(
      svc.store(1, 2, 'h', 'SELECT 1', { columns: [], rows: [] }, 1, 60),
    ).resolves.toBeUndefined();
  });
});
