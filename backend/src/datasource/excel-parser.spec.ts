import ExcelJS from 'exceljs';
import { parseExcelBuffer, toPreview } from './excel-parser';

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
