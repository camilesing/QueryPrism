// MetricImportService unit tests (MetaDataImprove): scope/enabled on the
// metric + standard ingestion paths, per-row authority, and the merged
// by_scope summary.
import ExcelJS from 'exceljs';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  MetricImportService,
  type MetricImportRow,
  type StandardImportRow,
} from './metric-import.service';

setI18n(createTestI18n());

function withUser<T>(
  user: { id: number; oid: number; weight?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: `u${user.id}`,
        oid: user.oid,
        language: 'en',
        weight: user.weight ?? 0,
      },
    },
    fn,
  );
}

const MEMBER = { id: 7, oid: 1, weight: 0 };
const WS_ADMIN = { id: 5, oid: 1, weight: 1 };
const SYS_ADMIN = { id: 1, oid: 1, weight: 0 };

const ATOMIC_ROW: MetricImportRow = {
  kind: 'atomic',
  code: 'pay_amount',
  name: '支付金额',
  datasource_id: 1,
  table_name: 'sales_order',
  field_name: 'amount',
  aggregation: 'SUM',
};

const STANDARD_ROW: StandardImportRow = {
  kind: 'naming',
  code: 'gmv',
  term: 'GMV',
  name: '商品交易总额',
  category: 'business_noun',
};

function makeService() {
  const metricUpsert = jest.fn().mockResolvedValue({ applied: true, id: 11 });
  const standardUpsert = jest.fn().mockResolvedValue({ applied: true, id: 12 });
  const service = new MetricImportService(
    {} as never,
    { upsert: metricUpsert } as never,
    { upsert: standardUpsert } as never,
  );
  return { service, metricUpsert, standardUpsert };
}

describe('MetricImportService scope/enabled', () => {
  it('defaults old metric rows to WORKSPACE + enabled', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([ATOMIC_ROW]),
    );
    expect(out).toEqual({
      applied: 1,
      by_scope: { GLOBAL: 0, WORKSPACE: 1, PERSONAL: 0 },
      failed: [],
    });
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'WORKSPACE', enabled: true }),
    );
  });

  it('lets a member import PERSONAL metrics + standards', async () => {
    const { service, metricUpsert, standardUpsert } = makeService();
    const metrics = await withUser(MEMBER, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, scope: 'personal', enabled: '0' },
      ]),
    );
    const standards = await withUser(MEMBER, () =>
      service.importJsonStandards([{ ...STANDARD_ROW, scope: 'PERSONAL' }]),
    );
    expect(metrics.by_scope.PERSONAL).toBe(1);
    expect(standards.by_scope.PERSONAL).toBe(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL', enabled: false }),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL' }),
    );
  });

  it('fails WORKSPACE/GLOBAL rows for a member but keeps PERSONAL rows', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'ws', scope: 'WORKSPACE' },
        { ...ATOMIC_ROW, code: 'global', scope: 'GLOBAL' },
        { ...ATOMIC_ROW, code: 'mine', scope: 'PERSONAL' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.by_scope).toEqual({
      GLOBAL: 0,
      WORKSPACE: 0,
      PERSONAL: 1,
    });
    expect(out.failed).toHaveLength(2);
    expect(metricUpsert).toHaveBeenCalledTimes(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'mine', scope: 'PERSONAL' }),
    );
  });

  it('accepts GLOBAL for the system admin', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(SYS_ADMIN, () =>
      service.importJsonMetrics([{ ...ATOMIC_ROW, scope: 'GLOBAL' }]),
    );
    expect(out.by_scope.GLOBAL).toBe(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'GLOBAL' }),
    );
  });

  it('reports invalid metric/standard scopes without aborting the batch', async () => {
    const { service, standardUpsert } = makeService();
    const metrics = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'bad', scope: 'team' },
        { ...ATOMIC_ROW, code: 'good' },
      ]),
    );
    expect(metrics.applied).toBe(1);
    expect(metrics.failed).toHaveLength(1);
    expect(metrics.failed[0].row).toBe('row1');

    const standards = await withUser(WS_ADMIN, () =>
      service.importJsonStandards([
        { ...STANDARD_ROW, code: 'bad', scope: 'team' },
        { ...STANDARD_ROW, code: 'good' },
      ]),
    );
    expect(standards.applied).toBe(1);
    expect(standards.failed).toHaveLength(1);
    expect(standardUpsert).toHaveBeenCalledTimes(1);
  });
});

// ---- appended: six-sheet Excel export/import round-trips + row parsing ----

/** Prisma mock carrying the two findMany delegates exportAll reads. */
function makeExcelService(metrics: unknown[] = [], standards: unknown[] = []) {
  const metricUpsert = jest.fn().mockResolvedValue({ applied: true, id: 11 });
  const standardUpsert = jest.fn().mockResolvedValue({ applied: true, id: 12 });
  const prisma = {
    metricDef: { findMany: jest.fn().mockResolvedValue(metrics) },
    dataStandard: { findMany: jest.fn().mockResolvedValue(standards) },
  };
  const service = new MetricImportService(
    prisma as never,
    { upsert: metricUpsert } as never,
    { upsert: standardUpsert } as never,
  );
  return { service, prisma, metricUpsert, standardUpsert };
}

const metricRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  kind: 'atomic',
  code: 'x',
  name: 'x',
  aliases: null,
  description: null,
  unit: null,
  definition: {},
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  enabled: true,
  version: 1,
  ...over,
});

const standardRow = (
  over: Record<string, unknown>,
): Record<string, unknown> => ({
  id: 21,
  kind: 'unit',
  code: 'yuan',
  term: '元',
  name: '人民币元',
  aliases: null,
  category: null,
  description: null,
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  enabled: true,
  version: 1,
  ...over,
});

/** One metric of every kind + deliberately hand-corrupted rows. */
const EXPORT_METRICS = [
  metricRow({
    id: 1,
    code: 'pay_amount',
    name: '支付金额',
    aliases: ['支付额', '付款额'],
    unit: '元',
    description: '订单支付金额',
    definition: {
      datasource_id: 3,
      table_name: 'orders',
      field_name: 'amount',
      aggregation: 'SUM',
    },
  }),
  metricRow({
    id: 2,
    code: 'broken_null',
    name: '坏空定义',
    aliases: null,
    unit: null,
    description: null,
    enabled: false,
    scope: 'GLOBAL',
    oid: null,
    definition: null,
  }),
  metricRow({
    id: 3,
    code: 'broken_arr',
    name: '坏数组定义',
    definition: [1, 2],
  }),
  metricRow({
    id: 11,
    code: 'broken_obj',
    name: '坏对象字段',
    definition: {
      datasource_id: 3,
      table_name: { oops: true },
      field_name: 'f',
      aggregation: 'SUM',
    },
  }),
  metricRow({
    id: 4,
    kind: 'modifier',
    code: 'baby',
    name: '母婴',
    definition: {
      datasource_id: 3,
      table_name: 'orders',
      field_name: 'cat',
      operator: '=',
      values: ['A', '', 5],
    },
  }),
  metricRow({
    id: 5,
    kind: 'modifier',
    code: 'bad_values',
    name: '坏取值',
    definition: { operator: 'in', values: 'not-an-array' },
  }),
  metricRow({
    id: 6,
    kind: 'period',
    code: 'last_7d',
    name: '最近7天',
    definition: { mode: 'recent', time_unit: 'day', count: 7 },
  }),
  metricRow({
    id: 7,
    kind: 'period',
    code: 'ytd_p',
    name: '年初至今',
    definition: { mode: 'anchor', anchor: 'ytd' },
  }),
  metricRow({
    id: 8,
    kind: 'derived',
    code: 'baby_pay',
    name: '母婴支付',
    definition: {
      atomic_code: 'pay_amount',
      modifier_codes: ['m1', 2],
      period_code: 'last_7d',
      time_field: 'pay_time',
    },
  }),
  metricRow({
    id: 9,
    kind: 'derived',
    code: 'd_no_mods',
    name: '无修饰',
    definition: { atomic_code: 'x1' },
  }),
  metricRow({
    id: 10,
    kind: 'composite',
    code: 'atv',
    name: '客单价',
    definition: { expression: 'pay_amount / user_cnt' },
  }),
];

const EXPORT_STANDARDS = [
  standardRow({
    id: 21,
    kind: 'unit',
    code: 'yuan',
    term: '元',
    name: '人民币元',
    aliases: ['块'],
    category: 'currency',
    description: 'CNY元',
  }),
  standardRow({
    id: 22,
    kind: 'naming',
    code: 'gmv',
    term: 'GMV',
    name: '商品交易总额',
    aliases: null,
    category: null,
    description: null,
    enabled: false,
    scope: 'GLOBAL',
    oid: null,
  }),
];

/** Build an in-memory workbook, serialize it, return the xlsx Buffer. */
async function workbookBuffer(
  build: (wb: ExcelJS.Workbook) => void,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

describe('MetricImportService.exportAll', () => {
  it('writes all six sheets, scoped and enabled-flagged, for the visible layers', async () => {
    const { service, prisma } = makeExcelService(
      EXPORT_METRICS,
      EXPORT_STANDARDS,
    );
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    expect(prisma.metricDef.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: 1 },
          { scope: 'PERSONAL', oid: 1, ownerUid: 5 },
        ],
      },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
    });
    const wb = await loadWorkbook(buf);
    const atomic = wb.getWorksheet('atomic_metrics')!;
    expect(atomic).toBeDefined();
    expect(atomic.rowCount).toBe(5); // header + 4 atomic rows
    expect(atomic.getCell(1, 1).value).toBe('code');
    expect(atomic.getCell(1, 11).value).toBe('scope');
    // healthy row renders its definition fields
    expect(atomic.getCell(2, 4).value).toBe(3);
    expect(atomic.getCell(2, 5).value).toBe('orders');
    expect(atomic.getCell(2, 8).value).toBe('元');
    expect(atomic.getCell(2, 10).value).toBe('true');
    expect(atomic.getCell(2, 11).value).toBe('WORKSPACE');
    // a null definition degrades to empty strings / 0 instead of [object Object]
    expect(atomic.getCell(3, 4).value).toBe(0);
    expect(
      String((atomic.getCell(3, 5).value ?? '') as string | number | boolean),
    ).toBe('');
    expect(atomic.getCell(3, 10).value).toBe('false');
    expect(atomic.getCell(3, 11).value).toBe('GLOBAL');
    // an array definition degrades the same way
    expect(atomic.getCell(4, 4).value).toBe(0);
    expect(
      String((atomic.getCell(4, 7).value ?? '') as string | number | boolean),
    ).toBe('');
    // a nested-object field renders as '' instead of [object Object]
    expect(
      String((atomic.getCell(5, 5).value ?? '') as string | number | boolean),
    ).toBe('');
    expect(atomic.getCell(5, 7).value).toBe('SUM');
    // modifier sheet: array values join, non-strings stringify then drop empties
    const modifiers = wb.getWorksheet('modifiers')!;
    expect(modifiers.getCell(2, 8).value).toBe('A,5');
    expect(
      String(
        (modifiers.getCell(3, 8).value ?? '') as string | number | boolean,
      ),
    ).toBe('');
    // period sheet keeps count as a number
    const periods = wb.getWorksheet('time_periods')!;
    expect(periods.getCell(2, 6).value).toBe(7);
    expect(periods.getCell(3, 4).value).toBe('anchor');
    // derived sheet: modifier codes join ('m1,2'), period/time pass through
    const derived = wb.getWorksheet('derived_metrics')!;
    expect(derived.getCell(2, 5).value).toBe('m1,2');
    expect(derived.getCell(2, 6).value).toBe('last_7d');
    expect(
      String((derived.getCell(3, 5).value ?? '') as string | number | boolean),
    ).toBe('');
    // composite sheet
    expect(wb.getWorksheet('composite_metrics')!.getCell(2, 4).value).toBe(
      'pay_amount / user_cnt',
    );
    // data standards sheet
    const standards = wb.getWorksheet('data_standards')!;
    expect(standards.getCell(2, 6).value).toBe('currency');
    expect(standards.getCell(3, 8).value).toBe('false');
  });

  it('still emits all six sheets (headers only) when nothing is visible', async () => {
    const { service } = makeExcelService();
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    const wb = await loadWorkbook(buf);
    for (const name of [
      'atomic_metrics',
      'modifiers',
      'time_periods',
      'derived_metrics',
      'composite_metrics',
      'data_standards',
    ]) {
      const ws = wb.getWorksheet(name);
      expect(ws).toBeDefined();
      expect(ws!.rowCount).toBe(1);
    }
  });
});

describe('MetricImportService.importExcel', () => {
  it('round-trips an export back through upserts with scope + enabled intact', async () => {
    const { service, metricUpsert, standardUpsert } = makeExcelService(
      EXPORT_METRICS,
      EXPORT_STANDARDS,
    );
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    // the system admin may import every layer incl. the GLOBAL rows
    const out = await withUser(SYS_ADMIN, () => service.importExcel(buf));
    expect(out).toEqual({
      applied: 13,
      by_scope: { GLOBAL: 2, WORKSPACE: 11, PERSONAL: 0 },
      failed: [],
    });
    expect(metricUpsert).toHaveBeenCalledTimes(11);
    expect(standardUpsert).toHaveBeenCalledTimes(2);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'atomic',
        code: 'pay_amount',
        aliases: ['支付额', '付款额'],
        unit: '元',
        description: '订单支付金额',
        enabled: true,
        scope: 'WORKSPACE',
        definition: {
          datasource_id: 3,
          table_name: 'orders',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'broken_null',
        scope: 'GLOBAL',
        enabled: false,
        unit: undefined,
        definition: {
          datasource_id: 0,
          table_name: '',
          field_name: '',
          aggregation: '',
        },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'broken_obj',
        definition: {
          datasource_id: 3,
          table_name: '',
          field_name: 'f',
          aggregation: 'SUM',
        },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'modifier',
        code: 'baby',
        definition: {
          datasource_id: 3,
          table_name: 'orders',
          field_name: 'cat',
          operator: '=',
          values: ['A', '5'],
        },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'modifier',
        code: 'bad_values',
        definition: expect.objectContaining({ values: [] }),
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'period',
        code: 'last_7d',
        definition: { mode: 'recent', time_unit: 'day', count: 7 },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'period',
        code: 'ytd_p',
        definition: { mode: 'anchor', anchor: 'ytd' },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'derived',
        code: 'baby_pay',
        definition: {
          atomic_code: 'pay_amount',
          modifier_codes: ['m1', '2'],
          period_code: 'last_7d',
          time_field: 'pay_time',
        },
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'derived',
        code: 'd_no_mods',
        definition: expect.objectContaining({ atomic_code: 'x1' }),
      }),
    );
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'composite',
        code: 'atv',
        definition: { expression: 'pay_amount / user_cnt' },
      }),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unit',
        code: 'yuan',
        aliases: ['块'],
        category: 'currency',
        description: 'CNY元',
        enabled: true,
        scope: 'WORKSPACE',
      }),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'naming',
        code: 'gmv',
        aliases: [],
        category: undefined,
        enabled: false,
        scope: 'GLOBAL',
      }),
    );
  });

  it('stringifies rich text, formula results, links, errors, dates and primitives', async () => {
    const { service, metricUpsert } = makeService();
    const when = new Date('2026-03-04T05:06:07.000Z');
    const buf = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('atomic_metrics');
      ws.addRow([
        'code',
        'name',
        'aliases',
        'datasource_id',
        'table_name',
        'field_name',
        'aggregation',
        'unit',
        'description',
        'enabled',
        'scope',
      ]);
      ws.addRow([
        { richText: [{ text: 'pay_' }, { text: 'amount' }] },
        'r1',
        '',
        1,
        't',
        'f',
        'SUM',
        '',
        '',
        '',
        '',
      ]);
      ws.addRow([
        { formula: '"f_"&"code"', result: 'f_code' },
        'r2',
        '',
        1,
        't',
        'f',
        'SUM',
        '',
        '',
        '',
        '',
      ]);
      ws.addRow([
        { text: 'label', hyperlink: 'https://x.example' },
        'r3',
        '',
        1,
        't',
        'f',
        'SUM',
        '',
        '',
        '',
        '',
      ]);
      ws.addRow([
        { error: '#N/A' },
        'r4',
        '',
        1,
        't',
        'f',
        'SUM',
        '',
        '',
        '',
        '',
      ]);
      ws.addRow([42, 'r5', '', 1, 't', 'f', 'SUM', '', '', '', '']);
      ws.addRow([true, 'r6', '', 1, 't', 'f', 'SUM', '', '', '', '']);
      ws.addRow([null, 'r7', '', 1, 't', 'f', 'SUM', '', '', '', '']);
      const dateRow = ws.addRow([]);
      const cell = dateRow.getCell(1);
      cell.value = when;
      cell.numFmt = 'yyyy-mm-dd';
      dateRow.getCell(2).value = 'r8';
    });
    const out = await withUser(WS_ADMIN, () => service.importExcel(buf));
    expect(out.applied).toBe(8);
    expect(
      metricUpsert.mock.calls.map(([info]) => (info as { code: string }).code),
    ).toEqual([
      'pay_amount',
      'f_code',
      'label',
      '',
      '42',
      'true',
      '',
      when.toISOString(),
    ]);
  });

  it('labels failures by sheet and row number and rejects corrupt buffers', async () => {
    const { service } = makeService();
    const buf = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('atomic_metrics');
      ws.addRow([
        'code',
        'name',
        'aliases',
        'datasource_id',
        'table_name',
        'field_name',
        'aggregation',
        'unit',
        'description',
        'enabled',
        'scope',
      ]);
      ws.addRow(['a', 'A', '', 1, 't', 'f', 'SUM', '', '', '', 'team']);
      const std = wb.addWorksheet('data_standards');
      std.addRow([
        'kind',
        'code',
        'term',
        'name',
        'aliases',
        'category',
        'description',
        'enabled',
        'scope',
      ]);
      std.addRow(['unit', 'u1', 'T', 'N', '', '', '', '', 'WORKSPACE']);
    });
    const out = await withUser(WS_ADMIN, () => service.importExcel(buf));
    expect(out.applied).toBe(1); // the standard row
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].row).toBe('atomic#row2');
    expect(out.failed[0].reason).toBe('Unknown metric scope layer');

    await expect(
      withUser(WS_ADMIN, () =>
        service.importExcel(Buffer.from('definitely not a zip')),
      ),
    ).rejects.toThrow('not a valid xlsx workbook');
  });

  it('returns an empty summary for a workbook without any known sheet', async () => {
    const { service, metricUpsert, standardUpsert } = makeService();
    const buf = await workbookBuffer((wb) => {
      wb.addWorksheet('unrelated_sheet').addRow(['x']);
    });
    const out = await withUser(WS_ADMIN, () => service.importExcel(buf));
    expect(out).toEqual({
      applied: 0,
      by_scope: { GLOBAL: 0, WORKSPACE: 0, PERSONAL: 0 },
      failed: [],
    });
    expect(metricUpsert).not.toHaveBeenCalled();
    expect(standardUpsert).not.toHaveBeenCalled();
  });
});

describe('MetricImportService JSON row parsing', () => {
  it('assembles each kind definition from its per-kind fields', async () => {
    const { service, metricUpsert } = makeService();
    const rows: MetricImportRow[] = [
      {
        kind: 'atomic',
        code: 'a1',
        name: 'A1',
        datasource_id: '3',
        table_name: ' t ',
        field_name: 'f',
        aggregation: 'COUNT_DISTINCT',
        unit: '   ',
        description: '   ',
      },
      {
        kind: 'modifier',
        code: 'm1',
        name: 'M1',
        datasource_id: 2,
        table_name: 't',
        field_name: 'f',
        operator: 'in',
        values: 'x，y, z',
      },
      {
        kind: 'modifier',
        code: 'm2',
        name: 'M2',
        datasource_id: 'bad',
        table_name: 't',
        field_name: 'f',
        operator: '=',
        values: [' v1 ', ''],
      },
      {
        kind: 'period',
        code: 'p1',
        name: 'P1',
        mode: 'recent',
        time_unit: 'day',
        count: '3',
      },
      {
        kind: 'period',
        code: 'p2',
        name: 'P2',
        mode: 'recent',
        time_unit: 'week',
        count: '0',
      },
      { kind: 'period', code: 'p3', name: 'P3', mode: 'anchor', anchor: 'mtd' },
      { kind: 'period', code: 'p4', name: 'P4' },
      {
        kind: 'derived',
        code: 'd1',
        name: 'D1',
        atomic_code: ' a1 ',
        modifier_codes: [' m1 ', '', 'm2'],
        period_code: '   ',
        time_field: ' tf ',
      },
      {
        kind: 'derived',
        code: 'd2',
        name: 'D2',
        atomic_code: 'a1',
        modifier_codes: 'm1，m2',
      },
      { kind: 'composite', code: 'c1', name: 'C1', expression: ' a / b ' },
    ];
    const out = await withUser(WS_ADMIN, () => service.importJsonMetrics(rows));
    expect(out).toEqual({
      applied: 10,
      by_scope: { GLOBAL: 0, WORKSPACE: 10, PERSONAL: 0 },
      failed: [],
    });
    const byCode = new Map(
      metricUpsert.mock.calls.map(([info]) => [info.code, info]),
    );
    expect(byCode.get('a1')).toEqual(
      expect.objectContaining({
        unit: undefined,
        description: undefined,
        definition: {
          datasource_id: 3,
          table_name: 't',
          field_name: 'f',
          aggregation: 'COUNT_DISTINCT',
        },
      }),
    );
    expect(byCode.get('m1')!.definition).toEqual({
      datasource_id: 2,
      table_name: 't',
      field_name: 'f',
      operator: 'in',
      values: ['x', 'y', 'z'],
    });
    const m2 = byCode.get('m2')!.definition as Record<string, unknown>;
    expect(Number.isNaN(m2.datasource_id as number)).toBe(true);
    expect(m2.values).toEqual(['v1']);
    expect(byCode.get('p1')!.definition).toEqual({
      mode: 'recent',
      time_unit: 'day',
      count: 3,
    });
    expect(byCode.get('p2')!.definition).toEqual({
      mode: 'recent',
      time_unit: 'week',
    });
    expect(byCode.get('p3')!.definition).toEqual({
      mode: 'anchor',
      anchor: 'mtd',
    });
    expect(byCode.get('p4')!.definition).toEqual({
      mode: 'recent',
      time_unit: '',
    });
    expect(byCode.get('d1')!.definition).toEqual({
      atomic_code: 'a1',
      modifier_codes: ['m1', 'm2'],
      time_field: 'tf',
    });
    expect(byCode.get('d2')!.definition).toEqual({
      atomic_code: 'a1',
      modifier_codes: ['m1', 'm2'],
    });
    expect(byCode.get('c1')!.definition).toEqual({ expression: 'a / b' });
  });

  it('honors every accepted enabled spelling and fails unknown kinds per row', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'e1', enabled: false },
        { ...ATOMIC_ROW, code: 'e2', enabled: 'FALSE' },
        { ...ATOMIC_ROW, code: 'e3', enabled: 0 },
        { ...ATOMIC_ROW, code: 'e4', enabled: 'yes' },
        { kind: 'bogus', code: 'x1', name: 'X' },
        { code: 'nokind', name: 'N' },
      ]),
    );
    expect(out.applied).toBe(4);
    expect(out.failed.map((f) => f.row)).toEqual(['row5', 'row6']);
    expect(out.failed[0].reason).toBe('Unknown metric kind');
    const enabledByCode = new Map(
      metricUpsert.mock.calls.map(([info]) => [info.code, info.enabled]),
    );
    expect(enabledByCode.get('e1')).toBe(false);
    expect(enabledByCode.get('e2')).toBe(false);
    expect(enabledByCode.get('e3')).toBe(false);
    expect(enabledByCode.get('e4')).toBe(true);
  });

  it('parses standard rows: alias list forms, blank category, unit kind', async () => {
    const { service, standardUpsert } = makeService();
    await withUser(WS_ADMIN, () =>
      service.importJsonStandards([
        {
          kind: 'unit',
          code: 'u1',
          term: 'T',
          name: 'N',
          aliases: [' a ', '', 'b'],
          category: '   ',
          description: ' d ',
        },
        { kind: 'naming', code: 'n1', term: 'T2', name: 'N2', aliases: 'x，y' },
      ]),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unit',
        code: 'u1',
        aliases: ['a', 'b'],
        category: undefined,
        description: 'd',
        enabled: true,
        scope: 'WORKSPACE',
      }),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'naming',
        code: 'n1',
        aliases: ['x', 'y'],
      }),
    );
  });
});

describe('MetricImportService failure reporting', () => {
  it('reports proposal results and non-Error rejections per metric row', async () => {
    const metricUpsert = jest
      .fn()
      .mockResolvedValueOnce({ applied: false, request_id: 5 })
      .mockRejectedValueOnce('boom string')
      .mockResolvedValueOnce({ applied: true, id: 1 });
    const service = new MetricImportService(
      {} as never,
      { upsert: metricUpsert } as never,
      { upsert: jest.fn() } as never,
    );
    const out = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'proposal' },
        { ...ATOMIC_ROW, code: 'throws' },
        { ...ATOMIC_ROW, code: 'applies' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(2);
    expect(out.failed[0].reason).toContain('You may not import');
    expect(out.failed[1].reason).toBe('boom string');
  });

  it('reports proposal results and non-Error rejections per standard row', async () => {
    const standardUpsert = jest
      .fn()
      .mockResolvedValueOnce({ applied: false, request_id: 6 })
      .mockRejectedValueOnce(42);
    const service = new MetricImportService(
      {} as never,
      { upsert: jest.fn() } as never,
      { upsert: standardUpsert } as never,
    );
    const out = await withUser(WS_ADMIN, () =>
      service.importJsonStandards([
        { ...STANDARD_ROW, code: 'proposal' },
        { ...STANDARD_ROW, code: 'throws' },
      ]),
    );
    expect(out.applied).toBe(0);
    expect(out.failed[0].reason).toContain('You may not import');
    expect(out.failed[1].reason).toBe('42');
  });

  it('requires a signed-in user for import and export', async () => {
    const { service } = makeService();
    await expect(service.importJsonMetrics([ATOMIC_ROW])).rejects.toThrow(
      'No signed-in user',
    );
    await expect(service.exportAll()).rejects.toThrow('No signed-in user');
  });

  it('exposes the xlsx mime type for the download headers', () => {
    expect(MetricImportService.XLSX_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
