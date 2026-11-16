import ExcelJS from 'exceljs';
import {
  excelExtension,
  isSupportedExcelFile,
  parseExcelBuffer,
  toPreview,
} from './excel-parser';

describe('excel-parser', () => {
  it('parses an xlsx sheet, infers column types and builds a preview', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['id', 'name', 'score', 'when']);
    ws.addRow([1, 'Alice', 90.5, new Date('2026-01-02T00:00:00Z')]);
    ws.addRow([2, 'Bob', 75, new Date('2026-01-03T00:00:00Z')]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets).toHaveLength(1);
    expect(sheets[0].sheetName).toBe('Sheet1');
    expect(sheets[0].fields).toEqual([
      { fieldName: 'id', fieldType: 'int' },
      { fieldName: 'name', fieldType: 'string' },
      { fieldName: 'score', fieldType: 'float' },
      { fieldName: 'when', fieldType: 'datetime' },
    ]);
    expect(sheets[0].rows).toHaveLength(2);

    const preview = toPreview(sheets[0]);
    expect(preview.rows).toBe(2);
    expect(preview.data[0]).toMatchObject({
      id: 1,
      name: 'Alice',
      score: 90.5,
    });
  });

  it('parses CSV and de-duplicates repeated headers', async () => {
    const csv = 'id,name,name\n1,Alice,Ally\n2,Bob,Bobby\n';
    const sheets = await parseExcelBuffer(Buffer.from(csv), 'demo.csv');
    expect(sheets).toHaveLength(1);
    expect(sheets[0].fields.map((f) => f.fieldName)).toEqual([
      'id',
      'name',
      'name_2',
    ]);
    expect(sheets[0].rows).toHaveLength(2);
  });
});

// ─────────────── residual branch arms (coverage tail) ──────────────────────

describe('excel-parser — residual arms (coverage tail)', () => {
  it('blank headers fall back to Column_N; a Date header renders as ISO', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow([new Date('2026-01-02T00:00:00Z'), null, 'flag']);
    ws.addRow([1, 'x', true]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets[0].fields.map((f) => f.fieldName)).toEqual([
      '2026-01-02T00:00:00.000Z',
      'Column_2',
      'flag',
    ]);
    // boolean cells count as strings for type inference
    expect(sheets[0].fields[2].fieldType).toBe('string');
  });

  it('skips fully blank rows; sparse and whitespace-only cells stay empty', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['id', 'note']);
    ws.addRow([1, 'a']);
    ws.addRow([2]); // sparse: note cell never touched → null
    ws.addRow([null, null]); // entirely blank → dropped
    ws.addRow([3, '   ']); // whitespace-only string cell
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets[0].rows).toHaveLength(3);
    expect(sheets[0].rows[1]).toEqual([2, null]);
    expect(sheets[0].rows[2]).toEqual([3, '   ']);
    // note column: only 'a' is non-empty → string
    expect(sheets[0].fields.map((f) => f.fieldType)).toEqual(['int', 'string']);
  });

  it('numeric strings infer int/float; mixed-kind columns fall back to string', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['num', 'fl', 'mixed']);
    ws.addRow(['12', '3.5', '7']); // numeric-LOOKING strings survive round-trip
    ws.addRow(['8', '4.5', 'hello']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets[0].fields).toEqual([
      { fieldName: 'num', fieldType: 'int' },
      { fieldName: 'fl', fieldType: 'float' },
      { fieldName: 'mixed', fieldType: 'string' },
    ]);
  });

  it('normalizes formula/richText/hyperlink/error object cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['f', 'r', 'h', 'e']);
    ws.getRow(2).getCell(1).value = { formula: '1+2', result: 3 };
    ws.getRow(2).getCell(2).value = {
      richText: [{ text: 'a' }, { text: 'b' }],
    };
    ws.getRow(2).getCell(3).value = { text: 'link', hyperlink: 'http://x' };
    ws.getRow(2).getCell(4).value = { error: '#DIV/0!' };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets[0].rows[0]).toEqual([3, 'ab', 'link', null]);
    expect(sheets[0].fields.map((f) => f.fieldType)).toEqual([
      'int', // formula result
      'string', // joined rich text
      'string', // hyperlink text
      'string', // error cell → null → no values at all
    ]);
  });
});

describe('excel-parser — extension + empty sheet (coverage tail)', () => {
  it('excelExtension returns "" for names without a dot', () => {
    expect(excelExtension('README')).toBe('');
    expect(excelExtension('a.tar.gz')).toBe('.gz');
  });

  it('an empty worksheet parses to an empty sheet (no fields, no rows)', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Empty');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseExcelBuffer(buf, 'demo.xlsx');
    expect(sheets).toEqual([{ sheetName: 'Empty', fields: [], rows: [] }]);
  });
});

describe('isSupportedExcelFile', () => {
  it('accepts .xlsx/.csv (case-insensitive) and rejects everything else', () => {
    expect(isSupportedExcelFile('a.XLSX')).toBe(true);
    expect(isSupportedExcelFile('b.Csv')).toBe(true);
    expect(isSupportedExcelFile('legacy.xls')).toBe(false);
    expect(isSupportedExcelFile('noext')).toBe(false);
  });
});
