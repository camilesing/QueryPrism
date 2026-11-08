// Excel/CSV parser for the local-file datasource flow (parseExcel/uploadExcel):
// sheet discovery, per-column type inference, and a 10-row preview.
//
// Supported formats: .xlsx (ExcelJS) and .csv (ExcelJS csv reader). Legacy
// binary .xls is rejected with an actionable message — ExcelJS has no BIFF
// reader and QueryPrism does not ship SheetJS.
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

export type ExcelFieldType = 'string' | 'int' | 'float' | 'datetime';

export interface ExcelField {
  fieldName: string;
  fieldType: ExcelFieldType;
}

export type ExcelCell = string | number | boolean | Date | null;

export interface ParsedSheet {
  sheetName: string;
  fields: ExcelField[];
  rows: ExcelCell[][];
}

export interface ExcelPreviewSheet {
  sheetName: string;
  fields: ExcelField[];
  data: Record<string, unknown>[];
  rows: number;
}

type LoadParam = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];

const SUPPORTED = ['.xlsx', '.csv'];

export function excelExtension(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

export function isSupportedExcelFile(filename: string): boolean {
  return SUPPORTED.includes(excelExtension(filename));
}

/** Parse an uploaded workbook/CSV into sheet rows (header row excluded). */
export async function parseExcelBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ParsedSheet[]> {
  const ext = excelExtension(filename);
  const wb = new ExcelJS.Workbook();
  if (ext === '.csv') {
    // Wrap the buffer in an array: Readable.from(buffer) iterates bytes.
    await wb.csv.read(Readable.from([buffer]));
  } else {
    await wb.xlsx.load(buffer as unknown as LoadParam);
  }
  return wb.worksheets.map((ws) => parseSheet(ws));
}

function parseSheet(ws: ExcelJS.Worksheet): ParsedSheet {
  const sheetName = ws.name || 'Sheet1';
  const columnCount = ws.columnCount;
  if (columnCount === 0 || ws.rowCount === 0) {
    return { sheetName, fields: [], rows: [] };
  }

  const headers: string[] = [];
  const used = new Map<string, number>();
  for (let col = 1; col <= columnCount; col++) {
    const raw = cellText(ws.getRow(1).getCell(col).value).trim();
    const base = raw || `Column_${col}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    headers.push(seen === 0 ? base : `${base}_${seen + 1}`);
  }

  const rows: ExcelCell[][] = [];
  for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);
    const values: ExcelCell[] = [];
    let hasValue = false;
    for (let col = 1; col <= columnCount; col++) {
      const value = normalizeCell(row.getCell(col).value);
      values.push(value);
      if (!isEmptyCell(value)) hasValue = true;
    }
    if (hasValue) rows.push(values);
  }

  const fields = headers.map((fieldName, index) => ({
    fieldName,
    fieldType: inferFieldType(rows.map((r) => r[index])),
  }));

  return { sheetName, fields, rows };
}

/** Build the parseExcel response shape (fields + first 10 rows + total). */
export function toPreview(sheet: ParsedSheet, maxRows = 10): ExcelPreviewSheet {
  const data = sheet.rows.slice(0, maxRows).map((row) => {
    const obj: Record<string, unknown> = {};
    sheet.fields.forEach((field, index) => {
      obj[field.fieldName] = previewValue(row[index]);
    });
    return obj;
  });
  return {
    sheetName: sheet.sheetName,
    fields: sheet.fields,
    data,
    rows: sheet.rows.length,
  };
}

function inferFieldType(values: ExcelCell[]): ExcelFieldType {
  let dates = false;
  let numbers = false;
  let floats = false;
  let strings = false;
  for (const value of values) {
    if (isEmptyCell(value)) continue;
    if (value instanceof Date) {
      dates = true;
      continue;
    }
    if (typeof value === 'number') {
      numbers = true;
      if (!Number.isInteger(value)) floats = true;
      continue;
    }
    if (typeof value === 'boolean') {
      strings = true;
      continue;
    }
    const text = String(value).trim();
    if (text === '') continue;
    if (/^[-+]?\d+(\.\d+)?$/.test(text)) {
      numbers = true;
      if (!Number.isInteger(Number(text))) floats = true;
    } else {
      strings = true;
    }
  }
  const kinds = [dates, numbers, strings].filter(Boolean).length;
  if (kinds > 1) return 'string';
  if (dates) return 'datetime';
  if (numbers) return floats ? 'float' : 'int';
  return 'string';
}

function normalizeCell(value: ExcelJS.CellValue): ExcelCell {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  if (typeof value === 'object') {
    const obj = value as {
      richText?: { text?: string }[];
      text?: string;
      result?: ExcelJS.CellValue;
      error?: unknown;
    };
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => part.text ?? '').join('');
    }
    if (typeof obj.text === 'string') return obj.text;
    if (obj.result !== undefined) return normalizeCell(obj.result);
    if (obj.error !== undefined) return null;
  }
  // Unknown ExcelJS cell objects carry no displayable value.
  return null;
}

function cellText(value: ExcelJS.CellValue): string {
  const cell = normalizeCell(value);
  if (cell === null) return '';
  if (cell instanceof Date) return cell.toISOString();
  return String(cell);
}

function isEmptyCell(value: ExcelCell): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function previewValue(value: ExcelCell): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}
