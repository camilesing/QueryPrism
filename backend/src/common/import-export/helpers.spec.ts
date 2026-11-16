// Spec for the shared import/export helpers (2026-09 review P3-3): ExcelJS
// cell → text coercion, ds/adv list filtering, and the name-map builders
// (pure functions + a stubbed prisma client, no DI).
import type { PrismaService } from '../../database/prisma.service';
import {
  applyDsAdvFilters,
  buildAdvancedAppNamesMap,
  buildAssistantNameToIdMap,
  buildDatasourceNameToIdMap,
  buildDatasourceNamesMap,
  cellText,
} from './helpers';

/** Typed mock — cast to PrismaService only at each call site (repo pattern:
 * keeps eslint's type-aware rules able to resolve jest.Mock members). */
type MockPrisma = {
  datasource: { findMany: jest.Mock };
  assistant: { findMany: jest.Mock };
};

function makePrisma(): MockPrisma {
  return {
    datasource: { findMany: jest.fn() },
    assistant: { findMany: jest.fn() },
  };
}

describe('cellText', () => {
  it('maps null/undefined/string/number/boolean to plain strings', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText('订单')).toBe('订单');
    expect(cellText(42)).toBe('42');
    expect(cellText(true)).toBe('true');
  });

  it('joins richText runs, dropping blank and non-string fragments', () => {
    expect(
      cellText({
        richText: [{ text: '销售' }, { text: '' }, { text: '订单' }],
      }),
    ).toBe('销售订单');
    // a run without text contributes '' and is filtered; non-string text too
    expect(
      cellText({
        richText: [{ foo: 1 }, { text: 5 as unknown as string }, { text: 'x' }],
      }),
    ).toBe('x');
  });

  it('unwraps formula result objects recursively', () => {
    expect(cellText({ result: 42 })).toBe('42');
    expect(cellText({ result: { result: 'nested' } })).toBe('nested');
  });

  it('reads obj.text when it is a string, empty otherwise', () => {
    expect(cellText({ text: '备注' })).toBe('备注');
    expect(cellText({ text: 7 })).toBe('');
    expect(cellText({ error: '#N/A' })).toBe('');
    // non-object, non-scalar kinds (function) fall through to ''
    expect(cellText(() => 'x')).toBe('');
  });
});

describe('applyDsAdvFilters', () => {
  const rows = [
    {
      id: 1,
      specificDs: false,
      datasourceIds: null,
      advancedApplication: null,
    },
    {
      id: 2,
      specificDs: true,
      datasourceIds: [10, 20],
      advancedApplication: '5',
    },
    { id: 3, specificDs: true, datasourceIds: [30], advancedApplication: '9' },
    {
      id: 4,
      specificDs: true,
      datasourceIds: 'not-array',
      advancedApplication: '5',
    },
    { id: 5, specificDs: true, datasourceIds: [30], advancedApplication: '' },
  ];

  it('keeps everything when no filters are given (default args)', () => {
    expect(applyDsAdvFilters(rows)).toEqual(rows);
  });

  it('ds filter keeps global rows and rows scoped to a listed datasource', () => {
    const out = applyDsAdvFilters(rows, [30]);
    expect(out.map((r) => r.id)).toEqual([1, 3, 5]);
    expect(applyDsAdvFilters(rows, [10]).map((r) => r.id)).toEqual([1, 2]);
    // an empty dsList is "no filter", not "match nothing"
    expect(applyDsAdvFilters(rows, [], []).map((r) => r.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('adv filter matches stringified assistant ids; null/empty never match', () => {
    const out = applyDsAdvFilters(rows, [], [5]);
    expect(out.map((r) => r.id)).toEqual([2, 4]);
    expect(applyDsAdvFilters(rows, [], [5, 9]).map((r) => r.id)).toEqual([
      2, 3, 4,
    ]);
  });

  it('ds and adv filters compose', () => {
    expect(applyDsAdvFilters(rows, [30], [9]).map((r) => r.id)).toEqual([3]);
  });
});

describe('buildDatasourceNamesMap', () => {
  it('returns an empty map without querying when no ids are referenced', async () => {
    const prisma = makePrisma();
    const map = await buildDatasourceNamesMap(
      prisma as unknown as PrismaService,
      [{ datasourceIds: null }, { datasourceIds: 'nope' }, {}],
    );
    expect(map.size).toBe(0);
    expect(prisma.datasource.findMany).not.toHaveBeenCalled();
  });

  it('collects unique ids and maps id → name', async () => {
    const prisma = makePrisma();
    prisma.datasource.findMany.mockResolvedValue([
      { id: 10, name: 'mysql-main' },
      { id: 20, name: 'pg-analytics' },
    ]);
    const map = await buildDatasourceNamesMap(
      prisma as unknown as PrismaService,
      [{ datasourceIds: [10, 20] }, { datasourceIds: [10] }],
    );
    expect(map).toEqual(
      new Map([
        [10, 'mysql-main'],
        [20, 'pg-analytics'],
      ]),
    );
    expect(prisma.datasource.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 20] } },
      select: { id: true, name: true },
    });
  });

  it('scopes the query to the workspace when oid is supplied', async () => {
    const prisma = makePrisma();
    prisma.datasource.findMany.mockResolvedValue([]);
    await buildDatasourceNamesMap(
      prisma as unknown as PrismaService,
      [{ datasourceIds: [1] }],
      7,
    );
    expect(prisma.datasource.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1] }, oid: 7 },
      select: { id: true, name: true },
    });
  });
});

describe('buildAdvancedAppNamesMap', () => {
  it('returns an empty map without querying when no usable ids exist', async () => {
    const prisma = makePrisma();
    const map = await buildAdvancedAppNamesMap(
      prisma as unknown as PrismaService,
      [
        { advancedApplication: null },
        { advancedApplication: '' },
        { advancedApplication: 'not-a-number' },
      ],
    );
    expect(map.size).toBe(0);
    expect(prisma.assistant.findMany).not.toHaveBeenCalled();
  });

  it('parses stringified ids, queries once, maps id → name', async () => {
    const prisma = makePrisma();
    prisma.assistant.findMany.mockResolvedValue([
      { id: 5, name: '导购助手' },
      { id: 9, name: '运营助手' },
    ]);
    const map = await buildAdvancedAppNamesMap(
      prisma as unknown as PrismaService,
      [
        { advancedApplication: '5' },
        { advancedApplication: '9' },
        { advancedApplication: '5' },
      ],
    );
    expect(map).toEqual(
      new Map([
        [5, '导购助手'],
        [9, '运营助手'],
      ]),
    );
    expect(prisma.assistant.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 9] } },
      select: { id: true, name: true },
    });
  });
});

describe('buildDatasourceNameToIdMap', () => {
  it('queries all datasources and keys by trimmed name', async () => {
    const prisma = makePrisma();
    prisma.datasource.findMany.mockResolvedValue([
      { id: 2, name: '  pg  ' },
      { id: 3, name: 'mysql' },
      { id: 4, name: 'mysql' }, // duplicate name — NOTE: Map() keeps the LAST
    ]);
    const map = await buildDatasourceNameToIdMap(
      prisma as unknown as PrismaService,
    );
    expect(map.get('pg')).toBe(2);
    // Pin actual behavior: `new Map(rows.map(...))` overwrites duplicates, so
    // the LAST row wins — despite the source comment claiming "First-wins"
    // (helpers.ts:118-120). findMany has no orderBy, so which row is last is
    // DB-order-dependent.
    expect(map.get('mysql')).toBe(4);
    expect(prisma.datasource.findMany).toHaveBeenCalledWith({
      where: {},
      select: { id: true, name: true },
    });
  });

  it('scopes by oid when supplied', async () => {
    const prisma = makePrisma();
    prisma.datasource.findMany.mockResolvedValue([]);
    await buildDatasourceNameToIdMap(prisma as unknown as PrismaService, 7);
    expect(prisma.datasource.findMany).toHaveBeenCalledWith({
      where: { oid: 7 },
      select: { id: true, name: true },
    });
  });
});

describe('buildAssistantNameToIdMap', () => {
  it('queries workspace assistants and keys by trimmed name', async () => {
    const prisma = makePrisma();
    prisma.assistant.findMany.mockResolvedValue([
      { id: 5, name: ' assistant-a ' },
    ]);
    const map = await buildAssistantNameToIdMap(
      prisma as unknown as PrismaService,
      1,
    );
    expect(map.get('assistant-a')).toBe(5);
    expect(prisma.assistant.findMany).toHaveBeenCalledWith({
      where: { oid: 1 },
      select: { id: true, name: true },
    });
  });
});
