// SemanticImportService unit tests (MetaDataImprove): scope/enabled parsing,
// per-row direct-write authority (PERSONAL self / WORKSPACE admin / GLOBAL
// sysadmin) and the additive by_scope summary.
import ExcelJS from 'exceljs';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  SemanticImportService,
  type SemanticImportRow,
} from './semantic-import.service';

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

const ROW: SemanticImportRow = {
  entity_type: 'table',
  datasource_id: 1,
  table_name: 'sales_order',
  meaning: '销售订单主表',
};

function makeService() {
  const upsert = jest.fn().mockResolvedValue({ applied: true, id: 11 });
  const service = new SemanticImportService({} as never, { upsert } as never);
  return { service, upsert };
}

describe('SemanticImportService scope/enabled', () => {
  it('defaults old rows to WORKSPACE + enabled', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () => service.importJson([ROW]));
    expect(out).toEqual({
      applied: 1,
      by_scope: { GLOBAL: 0, WORKSPACE: 1, PERSONAL: 0 },
      failed: [],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'WORKSPACE', enabled: true }),
    );
  });

  it('passes explicit PERSONAL + enabled=false through to the service', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJson([{ ...ROW, scope: 'personal', enabled: 'false' }]),
    );
    expect(out.by_scope.PERSONAL).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL', enabled: false }),
    );
  });

  it('lets a member write only PERSONAL rows; WORKSPACE/GLOBAL rows fail', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJson([
        { ...ROW, table_name: 'ws_row', scope: 'WORKSPACE' },
        { ...ROW, table_name: 'global_row', scope: 'GLOBAL' },
        { ...ROW, table_name: 'personal_row', scope: 'PERSONAL' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.by_scope).toEqual({
      GLOBAL: 0,
      WORKSPACE: 0,
      PERSONAL: 1,
    });
    expect(out.failed).toHaveLength(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL' }),
    );
  });

  it('accepts GLOBAL only for the system admin', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(SYS_ADMIN, () =>
      service.importJson([{ ...ROW, scope: 'GLOBAL' }]),
    );
    expect(out.by_scope.GLOBAL).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'GLOBAL' }),
    );
  });

  it('reports an invalid scope row and keeps processing the batch', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJson([
        { ...ROW, table_name: 'bad', scope: 'team' },
        { ...ROW, table_name: 'good' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].row).toBe('row1');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'good' }),
    );
  });

  it('treats a proposal result as a failed row (no bulk approval routing)', async () => {
    const upsert = jest
      .fn()
      .mockResolvedValue({ applied: false, request_id: 9 });
    const service = new SemanticImportService({} as never, { upsert } as never);
    const out = await withUser(SYS_ADMIN, () =>
      service.importJson([{ ...ROW, scope: 'GLOBAL' }]),
    );
    expect(out.applied).toBe(0);
    expect(out.failed).toHaveLength(1);
  });
});

// ---- appended: Excel export/import round-trips + row parsing --------------

/** Prisma mock carrying the two findMany delegates exportAll reads. */
function makeExcelService(tables: unknown[] = [], fields: unknown[] = []) {
  const upsert = jest.fn().mockResolvedValue({ applied: true, id: 31 });
  const prisma = {
    tableSemantic: { findMany: jest.fn().mockResolvedValue(tables) },
    fieldSemantic: { findMany: jest.fn().mockResolvedValue(fields) },
  };
  const service = new SemanticImportService(
    prisma as never,
    {
      upsert,
    } as never,
  );
  return { service, prisma, upsert };
}

const tableRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  datasourceId: 1,
  tableName: 'sales_order',
  meaning: '销售订单主表',
  enabled: true,
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  version: 1,
  ...over,
});

const fieldRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 11,
  datasourceId: 1,
  tableName: 'sales_order',
  fieldName: 'channel',
  role: 'other',
  meaning: '销售渠道',
  unit: null,
  enumValues: null,
  enabled: true,
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  version: 1,
  ...over,
});

const EXPORT_TABLES = [
  tableRow({}),
  tableRow({
    id: 2,
    tableName: 'refund',
    meaning: '退款表',
    enabled: false,
    scope: 'GLOBAL',
    oid: null,
  }),
];

const EXPORT_FIELDS = [
  fieldRow({
    id: 11,
    role: 'dimension',
    unit: 'kg',
    enumValues: [
      { value: '1', label: '男' },
      { value: '2' }, // no label → bare value
      { value: 3, label: 4 }, // non-strings → skipped by the renderer
    ],
  }),
  fieldRow({ id: 12, fieldName: 'pay_time', role: 'time', enumValues: [] }),
];

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

describe('SemanticImportService.exportAll', () => {
  it('renders both sheets for the actor-visible layers with enum value|label pairs', async () => {
    const { service, prisma } = makeExcelService(EXPORT_TABLES, EXPORT_FIELDS);
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    expect(prisma.tableSemantic.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: 1 },
          { scope: 'PERSONAL', oid: 1, ownerUid: 5 },
        ],
      },
      orderBy: [{ datasourceId: 'asc' }, { tableName: 'asc' }],
    });
    const wb = await loadWorkbook(buf);
    const ts = wb.getWorksheet('table_semantics')!;
    expect(ts).toBeDefined();
    expect(ts.getCell(1, 1).value).toBe('datasource_id');
    expect(ts.getCell(1, 5).value).toBe('scope');
    expect(ts.getCell(2, 2).value).toBe('sales_order');
    expect(ts.getCell(2, 4).value).toBe('true');
    expect(ts.getCell(3, 4).value).toBe('false');
    expect(ts.getCell(3, 5).value).toBe('GLOBAL');
    const fs = wb.getWorksheet('field_semantics')!;
    expect(fs.getCell(1, 9).value).toBe('scope');
    // enum pairs render as value|label; label-less and non-string entries degrade
    expect(fs.getCell(2, 7).value).toBe('1|男,2');
    expect(fs.getCell(2, 6).value).toBe('kg');
    // an empty enum array renders as an empty cell
    expect(
      String((fs.getCell(3, 7).value ?? '') as string | number | boolean),
    ).toBe('');
    expect(
      String((fs.getCell(3, 6).value ?? '') as string | number | boolean),
    ).toBe('');
  });

  it('still emits both sheets (headers only) when nothing is visible', async () => {
    const { service } = makeExcelService();
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    const wb = await loadWorkbook(buf);
    for (const name of ['table_semantics', 'field_semantics']) {
      const ws = wb.getWorksheet(name);
      expect(ws).toBeDefined();
      expect(ws!.rowCount).toBe(1);
    }
  });
});

describe('SemanticImportService.importExcel', () => {
  it('round-trips an export back through upserts with role, enums, scope and enabled intact', async () => {
    const { service, upsert } = makeExcelService(EXPORT_TABLES, EXPORT_FIELDS);
    const buf = await withUser(WS_ADMIN, () => service.exportAll());
    const out = await withUser(SYS_ADMIN, () => service.importExcel(buf));
    expect(out).toEqual({
      applied: 4,
      by_scope: { GLOBAL: 1, WORKSPACE: 3, PERSONAL: 0 },
      failed: [],
    });
    expect(upsert).toHaveBeenCalledTimes(4);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'table',
        datasource_id: 1,
        table_name: 'sales_order',
        meaning: '销售订单主表',
        enabled: true,
        scope: 'WORKSPACE',
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'table',
        table_name: 'refund',
        enabled: false,
        scope: 'GLOBAL',
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'field',
        field_name: 'channel',
        role: 'dimension',
        unit: 'kg',
        enum_values: [{ value: '1', label: '男' }, { value: '2' }],
        enabled: true,
      }),
    );
    // the pay_time row carries neither unit nor enums after the round trip
    const payTime = upsert.mock.calls[3][0] as Record<string, unknown>;
    expect(payTime).toEqual({
      entity_type: 'field',
      scope: 'WORKSPACE',
      datasource_id: 1,
      table_name: 'sales_order',
      meaning: '销售渠道',
      enabled: true,
      field_name: 'pay_time',
      role: 'time',
    });
  });

  it('stringifies rich text, formula results, links, errors, dates and primitives', async () => {
    const { service, upsert } = makeService();
    const when = new Date('2026-05-06T07:08:09.000Z');
    const buf = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('table_semantics');
      ws.addRow(['datasource_id', 'table_name', 'meaning', 'enabled', 'scope']);
      ws.addRow([
        1,
        't1',
        { richText: [{ text: 'rt_' }, { text: 'cell' }] },
        '',
        '',
      ]);
      ws.addRow([1, 't2', { formula: '"f_"&"row"', result: 7 }, '', '']);
      ws.addRow([
        1,
        't3',
        { text: 'linktext', hyperlink: 'https://x.example' },
        '',
        '',
      ]);
      // an error cell stringifies to '' — in the scope column that means WORKSPACE
      ws.addRow([1, 't4', 'm', '', { error: '#DIV/0!' }]);
      ws.addRow([1, 't5', true, '', '']);
      const dateRow = ws.addRow([]);
      dateRow.getCell(1).value = 1;
      dateRow.getCell(2).value = 't6';
      const cell = dateRow.getCell(3);
      cell.value = when;
      cell.numFmt = 'yyyy-mm-dd';
    });
    const out = await withUser(WS_ADMIN, () => service.importExcel(buf));
    expect(out.applied).toBe(6);
    const byTable = new Map(
      upsert.mock.calls.map(([info]) => [info.table_name, info]),
    );
    expect(byTable.get('t1')!.meaning).toBe('rt_cell');
    expect(byTable.get('t2')!.meaning).toBe('7');
    expect(byTable.get('t3')!.meaning).toBe('linktext');
    expect(byTable.get('t4')!.scope).toBe('WORKSPACE');
    expect(byTable.get('t5')!.meaning).toBe('true');
    expect(byTable.get('t6')!.meaning).toBe(when.toISOString());
  });

  it('reads whichever sheets exist and reports failures with sheet#row labels', async () => {
    const { service } = makeService();
    const buf = await workbookBuffer((wb) => {
      // only a table sheet: exercises the missing field_semantics branch
      const ws = wb.addWorksheet('table_semantics');
      ws.addRow(['datasource_id', 'table_name', 'meaning', 'enabled', 'scope']);
      ws.addRow([1, 'good_table', '好表', '', 'WORKSPACE']);
      ws.addRow(['oops', 'bad_ds', '坏数据源', '', '']);
    });
    const out = await withUser(WS_ADMIN, () => service.importExcel(buf));
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toEqual({
      row: 'table#row3',
      reason: 'Table name, field name (for fields) and meaning are required',
    });

    const fieldOnly = await workbookBuffer((wb) => {
      // only a field sheet: exercises the missing table_semantics branch
      const ws = wb.addWorksheet('field_semantics');
      ws.addRow([
        'datasource_id',
        'table_name',
        'field_name',
        'role',
        'meaning',
        'unit',
        'enum_values',
        'enabled',
        'scope',
      ]);
      ws.addRow([1, 't', 'f', 'metric', '含义', '', '', '', 'PERSONAL']);
    });
    const fieldOut = await withUser(MEMBER, () =>
      service.importExcel(fieldOnly),
    );
    expect(fieldOut.applied).toBe(1);
    expect(fieldOut.by_scope.PERSONAL).toBe(1);

    const empty = await workbookBuffer((wb) => {
      wb.addWorksheet('unrelated').addRow(['x']);
    });
    const none = await withUser(WS_ADMIN, () => service.importExcel(empty));
    expect(none).toEqual({
      applied: 0,
      by_scope: { GLOBAL: 0, WORKSPACE: 0, PERSONAL: 0 },
      failed: [],
    });
  });

  it('rejects corrupt buffers without touching the service', async () => {
    const { service, upsert } = makeService();
    await expect(
      withUser(WS_ADMIN, () =>
        service.importExcel(Buffer.from('not a zip at all')),
      ),
    ).rejects.toThrow('not a valid xlsx workbook');
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('SemanticImportService JSON row parsing', () => {
  it('derives the entity type, validates ids and defaults the role', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJson([
        // entity_type field, explicit
        {
          entity_type: 'field',
          datasource_id: 1,
          table_name: 't',
          field_name: 'f1',
          meaning: 'm',
          role: 'dimension',
        },
        // no entity_type but a field_name → field
        {
          datasource_id: 1,
          table_name: 't',
          field_name: 'f2',
          meaning: 'm',
          role: 'time',
        },
        // unknown role falls back to other; blank unit omitted
        {
          datasource_id: 1,
          table_name: 't',
          field_name: 'f3',
          meaning: 'm',
          role: 'bogus',
          unit: '   ',
        },
        // no role at all → other; blank enum omitted
        {
          datasource_id: 1,
          table_name: 't',
          field_name: 'f4',
          meaning: 'm',
          enum_values: '   ',
        },
        // entity_type table wins only without a field_name
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 't2',
          meaning: 'm2',
        },
        // a table-typed row with a field_name still becomes a field
        {
          entity_type: 'table',
          datasource_id: 1,
          table_name: 't',
          field_name: 'f5',
          meaning: 'm',
        },
      ]),
    );
    expect(out.failed).toEqual([]);
    const byField = new Map(
      upsert.mock.calls.map(([info]) => [
        info.field_name ?? info.table_name,
        info,
      ]),
    );
    expect(byField.get('f1')).toEqual(
      expect.objectContaining({ entity_type: 'field', role: 'dimension' }),
    );
    expect(byField.get('f2')).toEqual(
      expect.objectContaining({ entity_type: 'field', role: 'time' }),
    );
    expect(byField.get('f3')!.role).toBe('other');
    expect(byField.get('f3')!.unit).toBeUndefined();
    expect(byField.get('f4')!.role).toBe('other');
    expect(byField.get('f4')!.enum_values).toBeUndefined();
    expect(byField.get('t2')).toEqual(
      expect.objectContaining({ entity_type: 'table' }),
    );
    expect(byField.get('f5')).toEqual(
      expect.objectContaining({ entity_type: 'field' }),
    );
  });

  it('parses enum pairs with labels, Chinese commas and trimming', async () => {
    const { service, upsert } = makeService();
    await withUser(WS_ADMIN, () =>
      service.importJson([
        {
          entity_type: 'field',
          datasource_id: 1,
          table_name: 't',
          field_name: 'f',
          meaning: 'm',
          enum_values: ' 1 | 男 ，2, 3 |  三等 ',
          unit: 'kg',
        },
      ]),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        enum_values: [
          { value: '1', label: '男' },
          { value: '2' },
          { value: '3', label: '三等' },
        ],
        unit: 'kg',
      }),
    );
  });

  it('fails rows with bad datasource ids or missing table/meaning/field — batch continues', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJson([
        { ...ROW, table_name: 'bad_text_id', datasource_id: 'abc' },
        { ...ROW, table_name: 'zero_id', datasource_id: 0 },
        { ...ROW, table_name: 'neg_id', datasource_id: -2 },
        { ...ROW, table_name: 'no_ds', datasource_id: undefined },
        { ...ROW, table_name: '', datasource_id: 1 },
        { datasource_id: 1, table_name: 'no_meaning', meaning: '   ' },
        {
          entity_type: 'field',
          datasource_id: 1,
          table_name: 't',
          field_name: '   ',
          meaning: 'm',
        },
        { ...ROW, table_name: 'good_tail' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'good_tail' }),
    );
    expect(out.failed.map((f) => f.row)).toEqual([
      'row1',
      'row2',
      'row3',
      'row4',
      'row5',
      'row6',
      'row7',
    ]);
    for (const f of out.failed) {
      expect(f.reason).toBe(
        'Table name, field name (for fields) and meaning are required',
      );
    }
  });

  it('reports non-Error rejections as plain strings', async () => {
    const upsert = jest.fn().mockRejectedValueOnce('db exploded');
    const service = new SemanticImportService(
      {} as never,
      {
        upsert,
      } as never,
    );
    const out = await withUser(WS_ADMIN, () =>
      service.importJson([ROW, { ...ROW, table_name: 'second' }]),
    );
    // first call rejects with the string; the mock keeps rejecting after that
    expect(out.failed[0]).toEqual({ row: 'row1', reason: 'db exploded' });
  });

  it('requires a signed-in user for import and export', async () => {
    const { service } = makeService();
    await expect(service.importJson([ROW])).rejects.toThrow(
      'No signed-in user',
    );
    // a parseable workbook (the load happens before the actor check)
    const valid = await workbookBuffer((wb) => {
      wb.addWorksheet('table_semantics').addRow([
        'datasource_id',
        'table_name',
        'meaning',
        'enabled',
        'scope',
      ]);
    });
    await expect(service.importExcel(valid)).rejects.toThrow(
      'No signed-in user',
    );
    await expect(service.exportAll()).rejects.toThrow('No signed-in user');
  });

  it('exposes the xlsx mime type for the download headers', () => {
    expect(SemanticImportService.XLSX_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
