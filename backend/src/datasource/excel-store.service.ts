// ExcelStoreService — local-file datasource storage. Excel sheets are
// imported into the application's own PostgreSQL and then queried through
// an "excel" datasource. The imported tables are isolated in a dedicated
// `excel_store` schema so Prisma's managed tables and the user files never
// collide.
//
// Responsibilities:
//  - save the uploaded .xlsx/.csv under `excel.uploadDir`
//  - parse it (excel-parser.ts) for the preview dialog
//  - import the selected sheets into `excel_store` with inferred/user-chosen
//    column types (parameterized batched INSERTs)
//  - drop a datasource's tables on delete (best effort)
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import {
  excelExtension,
  isSupportedExcelFile,
  parseExcelBuffer,
  toPreview,
  type ExcelCell,
  type ExcelField,
  type ExcelFieldType,
  type ExcelPreviewSheet,
  type ParsedSheet,
} from './excel-parser';
import { tr } from '../common/i18n/translate';
import { RequestContext } from '../common/context/request-context';
import { QueryCacheService } from '../quota/query-cache.service';

export interface ImportSheetRequest {
  sheetName: string;
  fields: ExcelField[];
}

export interface ImportSheetResult {
  sheetName: string;
  tableName: string;
  tableComment: string;
  rows: number;
}

export interface UploadPreview {
  filePath: string;
  data: ExcelPreviewSheet[];
}

const MAX_BYTES = 50 * 1024 * 1024;
const VALID_TYPES = new Set<ExcelFieldType>([
  'string',
  'int',
  'float',
  'datetime',
]);
const IDENT_RE = /^[\p{L}\p{N}_]+$/u;

@Injectable()
export class ExcelStoreService {
  private readonly logger = new Logger(ExcelStoreService.name);
  private readonly uploadDir: string;
  private readonly schema: string;

  constructor(
    private readonly config: ConfigService,
    private readonly queryCache: QueryCacheService,
  ) {
    this.uploadDir = resolve(
      config.get<string>('excel.uploadDir') ?? 'uploads/excel',
    );
    this.schema = config.get<string>('excel.storeSchema') ?? 'excel_store';
    if (!IDENT_RE.test(this.schema)) {
      throw new Error(`Invalid excel.storeSchema: ${this.schema}`);
    }
  }

  /** Save an upload and return its preview payload (parseExcel). */
  async receive(file: Express.Multer.File): Promise<UploadPreview> {
    this.validateUpload(file);
    const saved = await this.saveUpload(file);
    const sheets = await this.parseFile(saved.filename);
    return {
      filePath: saved.filename,
      data: sheets.map((s) => toPreview(s)),
    };
  }

  /** Legacy /datasource/uploadExcel: save + import every non-empty sheet. */
  async importWholeFile(
    file: Express.Multer.File,
  ): Promise<{ filename: string; sheets: ImportSheetResult[] }> {
    this.validateUpload(file);
    const saved = await this.saveUpload(file);
    const parsed = await this.parseFile(saved.filename);
    const requested: ImportSheetRequest[] = parsed
      .filter((s) => s.fields.length > 0)
      .map((s) => ({ sheetName: s.sheetName, fields: s.fields }));
    if (requested.length === 0) {
      throw new BadRequestException(tr('datasource.excel_no_data'));
    }
    const sheets = await this.importParsed(saved.filename, parsed, requested);
    return { filename: saved.filename, sheets };
  }

  /** POST /datasource/importToDb — import the previewed sheets. */
  async importToDb(
    filePath: string,
    sheets: ImportSheetRequest[],
  ): Promise<{ filename: string; sheets: ImportSheetResult[] }> {
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw new BadRequestException(tr('datasource.excel_no_sheets_selected'));
    }
    const parsed = await this.parseFile(filePath);
    const results = await this.importParsed(filePath, parsed, sheets);
    // M7: a re-import can replace data under table names other datasources
    // query — invalidate this workspace's query cache. Awaited so the bump
    // lands before the caller proceeds (no cross-request drift); a failure
    // only means entries live until their TTL.
    const oid = RequestContext.getUser()?.oid;
    if (oid !== undefined) {
      try {
        await this.queryCache.bumpRevision(oid);
      } catch (e) {
        this.logger.warn(
          `cache revision bump failed (oid=${oid}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { filename: filePath, sheets: results };
  }

  /** Drop a datasource's imported tables (delete flow). Best effort: a DB
   *  hiccup must not block deleting the datasource row. */
  async dropTables(tableNames: string[]): Promise<void> {
    const names = tableNames
      .map((n) => String(n))
      .filter((n) => IDENT_RE.test(n));
    if (names.length === 0) return;
    let client: Client | null = null;
    try {
      client = await this.connect();
      for (const name of names) {
        await client.query(`DROP TABLE IF EXISTS ${this.qualified(name)}`);
      }
    } catch (e) {
      this.logger.warn(
        `excel table cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      await client?.end().catch(() => undefined);
    }
  }

  // --- internals ---------------------------------------------------------

  private validateUpload(file: Express.Multer.File): void {
    if (!file || !file.buffer) {
      throw new BadRequestException(tr('common.excel_required'));
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(tr('datasource.file_too_large'));
    }
    const ext = excelExtension(file.originalname ?? '');
    if (ext === '.xls') {
      throw new BadRequestException(
        '暂不支持 .xls 旧格式，请另存为 .xlsx 或 .csv 后上传',
      );
    }
    if (!isSupportedExcelFile(file.originalname ?? '')) {
      throw new BadRequestException(tr('datasource.file_type_unsupported'));
    }
  }

  private async saveUpload(
    file: Express.Multer.File,
  ): Promise<{ filename: string; path: string }> {
    await fs.mkdir(this.uploadDir, { recursive: true });
    const original = basename(file.originalname ?? 'upload');
    const ext = excelExtension(original);
    const rawBase = original.slice(0, original.length - ext.length);
    const base =
      rawBase
        .replace(/[^\p{L}\p{N}_-]/gu, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'excel';
    const filename = `${base}_${randomBytes(5).toString('hex')}${ext}`;
    const path = resolve(this.uploadDir, filename);
    await fs.writeFile(path, file.buffer);
    return { filename, path };
  }

  private async parseFile(filename: string): Promise<ParsedSheet[]> {
    const path = await this.resolveUpload(filename);
    const buffer = await fs.readFile(path);
    try {
      return await parseExcelBuffer(buffer, filename);
    } catch (e) {
      throw new BadRequestException(
        `Excel 文件解析失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async resolveUpload(filename: string): Promise<string> {
    if (!filename || filename !== basename(filename)) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    const full = resolve(this.uploadDir, filename);
    if (dirname(full) !== this.uploadDir) {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    try {
      await fs.access(full);
    } catch {
      throw new NotFoundException(tr('common.file_not_found'));
    }
    return full;
  }

  private async importParsed(
    filename: string,
    parsed: ParsedSheet[],
    requested: ImportSheetRequest[],
  ): Promise<ImportSheetResult[]> {
    const byName = new Map(parsed.map((sheet) => [sheet.sheetName, sheet]));
    const normalized = requested.map((req) => {
      const sheet = byName.get(req.sheetName);
      if (!sheet) {
        throw new BadRequestException(
          tr('datasource.sheet_not_found', { name: req.sheetName }),
        );
      }
      const fields = (req.fields ?? []).map((field) => {
        const fieldType = field.fieldType;
        if (!VALID_TYPES.has(fieldType)) {
          throw new BadRequestException(
            `字段「${field.fieldName}」类型无效: ${field.fieldType}`,
          );
        }
        const index = sheet.fields.findIndex(
          (f) => f.fieldName === field.fieldName,
        );
        if (index < 0) {
          throw new BadRequestException(
            `工作表「${req.sheetName}」中不存在字段「${field.fieldName}」`,
          );
        }
        return { fieldName: field.fieldName, fieldType, index };
      });
      if (fields.length === 0) {
        throw new BadRequestException(
          tr('datasource.sheet_no_fields', { name: req.sheetName }),
        );
      }
      return { sheet, fields };
    });

    let client: Client | null = null;
    try {
      client = await this.connect();
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${this.quoteIdent(this.schema)}`,
      );
      await client.query('BEGIN');
      const results: ImportSheetResult[] = [];
      for (const { sheet, fields } of normalized) {
        const tableName = this.tableName(sheet.sheetName);
        const columnSql = fields
          .map(
            (f) =>
              `${this.quoteIdent(f.fieldName)} ${this.pgType(f.fieldType)}`,
          )
          .join(', ');
        await client.query(
          `CREATE TABLE ${this.qualified(tableName)} (${columnSql})`,
        );
        await this.insertRows(client, tableName, sheet, fields);

        results.push({
          sheetName: sheet.sheetName,
          tableName,
          tableComment: '',
          rows: sheet.rows.length,
        });
      }
      await client.query('COMMIT');
      // The file is only needed until the import commits.
      await fs.unlink(resolve(this.uploadDir, filename)).catch(() => undefined);
      return results;
    } catch (e) {
      await client?.query('ROLLBACK').catch(() => undefined);
      throw e instanceof BadRequestException
        ? e
        : new BadRequestException(
            `导入数据失败: ${e instanceof Error ? e.message : String(e)}`,
          );
    } finally {
      await client?.end().catch(() => undefined);
    }
  }

  private async insertRows(
    client: Client,
    tableName: string,
    sheet: ParsedSheet,
    fields: { fieldName: string; fieldType: ExcelFieldType; index: number }[],
  ): Promise<void> {
    if (sheet.rows.length === 0) return;
    const columns = fields.map((f) => this.quoteIdent(f.fieldName)).join(', ');
    const maxRowsPerBatch = Math.max(
      1,
      Math.min(500, Math.floor(30000 / fields.length)),
    );
    for (let start = 0; start < sheet.rows.length; start += maxRowsPerBatch) {
      const batch = sheet.rows.slice(start, start + maxRowsPerBatch);
      const params: unknown[] = [];
      const placeholders: string[] = [];
      batch.forEach((row, rowIndex) => {
        const cells = fields.map((field, col) => {
          const value = this.toDbValue(
            row[field.index],
            field.fieldType,
            start + rowIndex + 2, // spreadsheet row (header is row 1)
            field.fieldName,
          );
          params.push(value);
          return `$${rowIndex * fields.length + col + 1}`;
        });
        placeholders.push(`(${cells.join(', ')})`);
      });
      await client.query(
        `INSERT INTO ${this.qualified(tableName)} (${columns}) VALUES ${placeholders.join(', ')}`,
        params,
      );
    }
  }

  private toDbValue(
    value: ExcelCell,
    type: ExcelFieldType,
    rowNum: number,
    fieldName: string,
  ): unknown {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return null;
    }
    if (type === 'string') return String(value);
    if (type === 'int' || type === 'float') {
      const num =
        typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(num)) {
        throw new BadRequestException(
          `第 ${rowNum} 行「${fieldName}」不是有效数字: ${String(value)}`,
        );
      }
      if (type === 'int') {
        const rounded = Math.round(num);
        if (!Number.isSafeInteger(rounded)) {
          throw new BadRequestException(
            `第 ${rowNum} 行「${fieldName}」超出整数范围: ${String(value)}`,
          );
        }
        return rounded;
      }
      return num;
    }
    // datetime
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
      // Excel serial date (days since 1899-12-30).
      return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    }
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `第 ${rowNum} 行「${fieldName}」不是有效日期: ${String(value)}`,
      );
    }
    return date;
  }

  private pgType(type: ExcelFieldType): string {
    switch (type) {
      case 'int':
        return 'BIGINT';
      case 'float':
        return 'DOUBLE PRECISION';
      case 'datetime':
        return 'TIMESTAMP';
      default:
        return 'TEXT';
    }
  }

  private tableName(sheetName: string): string {
    const base =
      sheetName
        .replace(/[^\p{L}\p{N}_]/gu, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'sheet';
    const name = `excel_${base}_${randomBytes(5).toString('hex')}`;
    if (new TextEncoder().encode(name).length > 63) {
      throw new BadRequestException(
        tr('datasource.sheet_name_too_long', { name: sheetName }),
      );
    }
    return name;
  }

  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private qualified(name: string): string {
    return `${this.quoteIdent(this.schema)}.${this.quoteIdent(name)}`;
  }

  private async connect(): Promise<Client> {
    const url =
      this.config.get<string>('DATABASE_URL') ?? process.env.DATABASE_URL;
    if (!url) {
      throw new BadRequestException(tr('datasource.database_url_missing'));
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    return client;
  }
}

// Re-export the preview/field shapes for the controller's response typing.
export type { ExcelPreviewSheet, ExcelField };
