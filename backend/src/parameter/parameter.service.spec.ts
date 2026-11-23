// ParameterService spec — reconciles the parameter module to the frontend's
// contract. The frontend consumes every
// /system/parameter/* GET as a list of {pkey, pval} pairs (Handler.vue:385,
// chatConfig.ts:48, parameter/index.vue:22) and POSTs the admin save as a
// multipart form whose `data` text field is a JSON string of [{pkey, pval}]
// (parameter/index.vue:84). Storage reuses SystemVariable with type=
// 'parameter'; the group is the pkey prefix (login.*, chat.*, platform.*),
// mirroring the frontend admin page's own prefix filter.
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { EmbeddingBackfillService } from '../embedding/embedding-backfill.service';
import {
  ParameterService,
  parseParameterItems,
  type ParameterItem,
} from './parameter.service';

describe('parseParameterItems', () => {
  it('parses a JSON array of {pkey,pval} into typed items', () => {
    expect(
      parseParameterItems(
        JSON.stringify([
          { pkey: 'login.default_login', pval: '0' },
          { pkey: 'chat.show_sql', pval: 'true' },
        ]),
      ),
    ).toEqual<ParameterItem[]>([
      { pkey: 'login.default_login', pval: '0' },
      { pkey: 'chat.show_sql', pval: 'true' },
    ]);
  });

  it('returns an empty array for an empty JSON array', () => {
    expect(parseParameterItems('[]')).toEqual([]);
  });

  it('throws BadRequest when data is not valid JSON', () => {
    expect(() => parseParameterItems('not-json')).toThrow(BadRequestException);
  });

  it('throws BadRequest when data is not an array', () => {
    expect(() => parseParameterItems('{"pkey":"x","pval":"y"}')).toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequest when an item is missing a string pkey', () => {
    expect(() => parseParameterItems(JSON.stringify([{ pval: 'y' }]))).toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequest when an item pval is not a string', () => {
    expect(() =>
      parseParameterItems(JSON.stringify([{ pkey: 'x', pval: 5 }])),
    ).toThrow(BadRequestException);
  });
});

describe('ParameterService', () => {
  let service: ParameterService;
  let backfill: { runTablesAndDatasources: jest.Mock };
  let prisma: {
    systemVariable: { findMany: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      // default resolveEmbeddingConfig read → env defaults (both on)
      systemVariable: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    backfill = {
      runTablesAndDatasources: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        ParameterService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmbeddingBackfillService, useValue: backfill },
      ],
    }).compile();
    service = module.get(ParameterService);
  });

  describe('getGroup', () => {
    it("queries parameter rows whose pkey starts with '<group>.' (QW3)", async () => {
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await service.getGroup('login');
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: {
          type: 'parameter',
          name: { startsWith: 'login.', mode: 'insensitive' },
        },
      });
    });

    it('maps each row name/value to pkey/pval', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'login.default_login', value: '0' },
      ]);
      await expect(service.getGroup('login')).resolves.toEqual([
        { pkey: 'login.default_login', pval: '0' },
      ]);
    });

    it('coerces non-string Json scalars to string pval', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'chat.show_sql', value: true },
        { name: 'chat.limit_rows', value: 3 },
      ]);
      await expect(service.getGroup('chat')).resolves.toEqual([
        { pkey: 'chat.show_sql', pval: 'true' },
        { pkey: 'chat.limit_rows', pval: '3' },
      ]);
    });

    it('returns [] when no rows are configured', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await expect(service.getGroup('login')).resolves.toEqual([]);
    });
  });

  describe('getAll', () => {
    it('queries all parameter rows (type=parameter)', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await service.getAll();
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: { type: 'parameter' },
      });
    });

    it('maps mixed login/chat/platform rows to {pkey,pval}', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'login.default_login', value: 1 },
        { name: 'chat.show_sql', value: true },
        { name: 'platform.name', value: 'QueryPrism' },
      ]);
      const items = await service.getAll();
      // the three stored rows come through verbatim
      expect(items).toContainEqual({ pkey: 'login.default_login', pval: '1' });
      expect(items).toContainEqual({ pkey: 'chat.show_sql', pval: 'true' });
      expect(items).toContainEqual({
        pkey: 'platform.name',
        pval: 'QueryPrism',
      });
      // 9e6070e8: every unsaved embedding.* key is appended at its backend-
      // resolved effective value (env/code defaults here)
      expect(items).toContainEqual({
        pkey: 'embedding.table_alpha',
        pval: '0.4',
      });
      expect(items).toContainEqual({
        pkey: 'embedding.table_count',
        pval: '10',
      });
      expect(items.filter((i) => i.pkey.startsWith('embedding.'))).toHaveLength(
        5,
      );
    });

    it('a saved embedding row is not duplicated by the effective-value append', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'embedding.table_alpha', value: '0.8' },
      ]);
      const items = await service.getAll();
      expect(items.filter((i) => i.pkey === 'embedding.table_alpha')).toEqual([
        { pkey: 'embedding.table_alpha', pval: '0.8' },
      ]);
    });
  });

  describe('save', () => {
    it('buckets saves: createMany for new keys + per-key updates for existing (P3-2)', async () => {
      const tx = {
        systemVariable: {
          findMany: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(
        // The service's $transaction callback is typed against
        // Prisma.TransactionClient; the mock forwards it our tx. Typing `cb`
        // keeps the call/return off `any` for the lint unsafe rules.
        (cb: (tx: typeof tx) => Promise<ParameterItem[]>) => cb(tx),
      );
      // First findMany (dup scan) reports chat.show_sql already exists; the
      // final findMany (result set) returns [].
      tx.systemVariable.findMany
        .mockResolvedValueOnce([{ name: 'chat.show_sql' }])
        .mockResolvedValueOnce([]);
      tx.systemVariable.createMany.mockResolvedValue({ count: 1 });
      tx.systemVariable.update.mockResolvedValue({});

      await service.save([
        { pkey: 'login.default_login', pval: '0' },
        { pkey: 'chat.show_sql', pval: 'true' },
      ]);

      // ONE createMany for the new key (with the parameter typing).
      expect(tx.systemVariable.createMany).toHaveBeenCalledWith({
        data: [
          {
            name: 'login.default_login',
            type: 'parameter',
            varType: 'str',
            value: '0',
          },
        ],
      });
      // Per-key update only for the EXISTING key.
      expect(tx.systemVariable.update).toHaveBeenCalledTimes(1);
      expect(tx.systemVariable.update).toHaveBeenCalledWith({
        where: { name: 'chat.show_sql' },
        data: { value: 'true' },
      });
    });

    it('returns the full parameter set mapped to {pkey,pval} after save', async () => {
      const tx = {
        systemVariable: {
          findMany: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(
        // The service's $transaction callback is typed against
        // Prisma.TransactionClient; the mock forwards it our tx. Typing `cb`
        // keeps the call/return off `any` for the lint unsafe rules.
        (cb: (tx: typeof tx) => Promise<ParameterItem[]>) => cb(tx),
      );
      tx.systemVariable.findMany
        .mockResolvedValueOnce([{ name: 'login.default_login' }])
        .mockResolvedValueOnce([{ name: 'login.default_login', value: '0' }]);
      tx.systemVariable.update.mockResolvedValue({});

      await expect(
        service.save([{ pkey: 'login.default_login', pval: '0' }]),
      ).resolves.toEqual([{ pkey: 'login.default_login', pval: '0' }]);
    });

    it('does nothing when the item list is empty', async () => {
      const tx = {
        systemVariable: { upsert: jest.fn(), findMany: jest.fn() },
      };
      prisma.$transaction.mockImplementation(
        // The service's $transaction callback is typed against
        // Prisma.TransactionClient; the mock forwards it our tx. Typing `cb`
        // keeps the call/return off `any` for the lint unsafe rules.
        (cb: (tx: typeof tx) => Promise<ParameterItem[]>) => cb(tx),
      );
      tx.systemVariable.findMany.mockResolvedValue([]);

      await expect(service.save([])).resolves.toEqual([]);
      expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
    });

    // --- 9e6070e8: strict embedding.* save validation ----------------------
    it('rejects the whole save on an invalid embedding value (no transaction)', async () => {
      await expect(
        service.save([
          { pkey: 'chat.show_sql', pval: 'true' },
          { pkey: 'embedding.table_alpha', pval: '1.5' }, // out of [0,1]
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a non-positive embedding count and a 0/1 boolean', async () => {
      await expect(
        service.save([{ pkey: 'embedding.table_count', pval: '0' }]),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.save([{ pkey: 'embedding.table_enabled', pval: '1' }]),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts valid embedding values and proceeds to the transaction', async () => {
      const tx = {
        systemVariable: {
          findMany: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(
        (cb: (tx: unknown) => Promise<ParameterItem[]>) => cb(tx),
      );
      tx.systemVariable.findMany.mockResolvedValue([]);
      tx.systemVariable.createMany.mockResolvedValue({ count: 1 });

      await expect(
        service.save([
          { pkey: 'embedding.table_alpha', pval: '0.6' },
          { pkey: 'embedding.table_count', pval: '12' },
          { pkey: 'embedding.keyword_enabled', pval: 'true' },
        ]),
      ).resolves.toBeDefined();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    // --- 9e6070e8 lifecycle: a false→true re-enable fires the backfill -----
    it('fires the metadata backfill when embedding.table_enabled flips false→true', async () => {
      const tx = {
        systemVariable: {
          findMany: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(
        (cb: (tx: unknown) => Promise<ParameterItem[]>) => cb(tx),
      );
      tx.systemVariable.findMany.mockResolvedValue([]);
      tx.systemVariable.createMany.mockResolvedValue({ count: 1 });
      tx.systemVariable.update.mockResolvedValue({});
      prisma.systemVariable.findMany
        .mockResolvedValueOnce([
          { name: 'embedding.table_enabled', value: 'false' },
        ])
        .mockResolvedValueOnce([
          { name: 'embedding.table_enabled', value: 'true' },
        ]);

      await service.save([{ pkey: 'embedding.table_enabled', pval: 'true' }]);
      await new Promise((r) => setImmediate(r));

      expect(backfill.runTablesAndDatasources).toHaveBeenCalledTimes(1);
    });

    it('fires no backfill when neither switch flipped (stays enabled)', async () => {
      const tx = {
        systemVariable: {
          findMany: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(
        (cb: (tx: unknown) => Promise<ParameterItem[]>) => cb(tx),
      );
      tx.systemVariable.findMany.mockResolvedValue([]);
      tx.systemVariable.createMany.mockResolvedValue({ count: 1 });

      await service.save([{ pkey: 'chat.show_sql', pval: 'true' }]);
      await new Promise((r) => setImmediate(r));

      expect(backfill.runTablesAndDatasources).not.toHaveBeenCalled();
    });
  });
});

// ─────────────── tail-sweep: residual parse/backfill arms ───────────────

describe('parseParameterItems (missing data field)', () => {
  it('throws BadRequest when the multipart data field is absent', () => {
    expect(() => parseParameterItems(undefined)).toThrow(BadRequestException);
    expect(() => parseParameterItems('')).toThrow(BadRequestException);
  });
});

describe('ParameterService tail-sweep', () => {
  let service: ParameterService;
  let backfill: {
    runTablesAndDatasources: jest.Mock;
    runMetrics: jest.Mock;
  };
  let prisma: {
    systemVariable: { findMany: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      systemVariable: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    backfill = {
      runTablesAndDatasources: jest.fn().mockResolvedValue(undefined),
      runMetrics: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        ParameterService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmbeddingBackfillService, useValue: backfill },
      ],
    }).compile();
    service = module.get(ParameterService);
  });

  function txWith() {
    const tx = {
      systemVariable: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => Promise<ParameterItem[]>) => cb(tx),
    );
    return tx;
  }

  it('within-request duplicate pkeys take the LAST value', async () => {
    const tx = txWith();
    await service.save([
      { pkey: 'chat.show_sql', pval: 'false' },
      { pkey: 'chat.show_sql', pval: 'true' },
    ]);
    expect(tx.systemVariable.createMany).toHaveBeenCalledWith({
      data: [
        {
          name: 'chat.show_sql',
          type: 'parameter',
          varType: 'str',
          value: 'true',
        },
      ],
    });
  });

  it('fires the metric backfill when metric.enabled flips false→true', async () => {
    txWith();
    prisma.systemVariable.findMany
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'false' }])
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'true' }]);

    await service.save([{ pkey: 'metric.enabled', pval: 'true' }]);
    await new Promise((r) => setImmediate(r));

    expect(backfill.runMetrics).toHaveBeenCalledTimes(1);
    expect(backfill.runTablesAndDatasources).not.toHaveBeenCalled();
  });

  it('a failing metadata backfill only logs (non-Error rejection)', async () => {
    txWith();
    const errorSpy = jest
      .spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    backfill.runTablesAndDatasources.mockRejectedValue('plain string');
    prisma.systemVariable.findMany
      .mockResolvedValueOnce([
        { name: 'embedding.table_enabled', value: 'false' },
      ])
      .mockResolvedValueOnce([
        { name: 'embedding.table_enabled', value: 'true' },
      ]);

    await expect(
      service.save([{ pkey: 'embedding.table_enabled', pval: 'true' }]),
    ).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('plain string'),
    );
  });

  it('a failing metric backfill only logs (both rejection shapes)', async () => {
    txWith();
    const errorSpy = jest
      .spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    backfill.runMetrics.mockRejectedValueOnce(new Error('metric vec failed'));
    prisma.systemVariable.findMany
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'false' }])
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'true' }]);
    await service.save([{ pkey: 'metric.enabled', pval: 'true' }]);
    await new Promise((r) => setImmediate(r));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('metric vec failed'),
    );

    backfill.runMetrics.mockRejectedValueOnce('plain metric failure');
    prisma.systemVariable.findMany
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'false' }])
      .mockResolvedValueOnce([{ name: 'metric.enabled', value: 'true' }]);
    await service.save([{ pkey: 'metric.enabled', pval: 'true' }]);
    await new Promise((r) => setImmediate(r));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('plain metric failure'),
    );
  });
});

describe('ParameterService backfill rejection shapes (both arms)', () => {
  let service: ParameterService;
  let backfill: {
    runTablesAndDatasources: jest.Mock;
    runMetrics: jest.Mock;
  };
  let prisma: {
    systemVariable: { findMany: jest.Mock; upsert: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      systemVariable: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    backfill = {
      runTablesAndDatasources: jest.fn().mockResolvedValue(undefined),
      runMetrics: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        ParameterService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmbeddingBackfillService, useValue: backfill },
      ],
    }).compile();
    service = module.get(ParameterService);
    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => Promise<ParameterItem[]>) =>
        cb({
          systemVariable: {
            findMany: jest.fn().mockResolvedValue([]),
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({}),
          },
        }),
    );
  });

  it('metadata backfill Error rejection uses its message in the log', async () => {
    const errorSpy = jest
      .spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    backfill.runTablesAndDatasources.mockRejectedValue(
      new Error('excel store gone'),
    );
    prisma.systemVariable.findMany
      .mockResolvedValueOnce([
        { name: 'embedding.table_enabled', value: 'false' },
      ])
      .mockResolvedValueOnce([
        { name: 'embedding.table_enabled', value: 'true' },
      ]);

    await service.save([{ pkey: 'embedding.table_enabled', pval: 'true' }]);
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('excel store gone'),
    );
  });

  it('a skipped table backfill (already enabled before) runs nothing', async () => {
    // both configs resolve enabled → no flip → no backfill calls at all
    await service.save([{ pkey: 'chat.show_sql', pval: 'true' }]);
    await new Promise((r) => setImmediate(r));
    expect(backfill.runTablesAndDatasources).not.toHaveBeenCalled();
    expect(backfill.runMetrics).not.toHaveBeenCalled();
  });
});
