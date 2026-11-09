// SemanticImportService — the M2 ingestion paths: Excel export/template/
// import (admin surface, terminology pattern) + the JSON batch used by the
// authenticated meta API (ApiKeyGuard). All imports apply at the WORKSPACE
// layer and require the actor to administer that workspace — an external
// sync pipeline must carry an admin's key (fail loud, no silent downscope).
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import { isWorkspaceAdmin } from './semantic-policy';
import { SemanticService, type SemanticUpsertInfo } from './semantic.service';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Safe cell-value → string (ExcelJS rich text / formula / hyperlinks / dates
 *  must not stringify into '[object Object]'). */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as {
      richText?: Array<{ text?: unknown }>;
      text?: unknown;
      result?: unknown;
      hyperlink?: unknown;
    };
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((r) => (typeof r.text === 'string' ? r.text : ''))
        .join('');
    }
    if (typeof v.text === 'string') return v.text;
    if (v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if (typeof v.hyperlink === 'string') return v.hyperlink;
  }
  return '';
}

/** One parsed row (Excel or JSON) of a semantic import. */
export interface SemanticImportRow {
  entity_type?: string;
  datasource_id?: number | string;
  table_name?: string;
  field_name?: string | null;
  role?: string | null;
  meaning?: string;
  unit?: string | null;
  /** "value|label,value|label" or "value,value" — parsed into enum_values. */
  enum_values?: string | null;
}

@Injectable()
export class SemanticImportService {
  private readonly logger = new Logger(SemanticImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly semanticService: SemanticService,
  ) {}

  private requireWorkspaceAdmin(): void {
    const user = RequestContext.getUser();
    if (!user || !isWorkspaceAdmin(user)) {
      throw new ForbiddenException(tr('semantic.import_forbidden'));
    }
  }

  // ---- export -----------------------------------------------------------

  /** Export the actor-visible semantic rows (both entity types, two sheets). */
  async exportAll(): Promise<Buffer> {
    const user = RequestContext.getUser();
    if (!user) throw new ForbiddenException(tr('semantic.no_context_user'));
    const visible = {
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'WORKSPACE', oid: user.oid },
        { scope: 'PERSONAL', oid: user.oid, ownerUid: user.id },
      ],
    };
    const [tables, fields] = await Promise.all([
      this.prisma.tableSemantic.findMany({
        where: visible,
        orderBy: [{ datasourceId: 'asc' }, { tableName: 'asc' }],
      }),
      this.prisma.fieldSemantic.findMany({
        where: visible,
        orderBy: [{ datasourceId: 'asc' }, { tableName: 'asc' }],
      }),
    ]);
    const wb = new ExcelJS.Workbook();
    const ts = wb.addWorksheet('table_semantics');
    ts.columns = [
      { header: 'datasource_id', key: 'datasource_id', width: 14 },
      { header: 'table_name', key: 'table_name', width: 28 },
      { header: 'meaning', key: 'meaning', width: 48 },
      { header: 'enabled', key: 'enabled', width: 10 },
    ];
    for (const t of tables) {
      ts.addRow({
        datasource_id: t.datasourceId,
        table_name: t.tableName,
        meaning: t.meaning,
        enabled: t.enabled ? 'true' : 'false',
      });
    }
    const fs = wb.addWorksheet('field_semantics');
    fs.columns = [
      { header: 'datasource_id', key: 'datasource_id', width: 14 },
      { header: 'table_name', key: 'table_name', width: 28 },
      { header: 'field_name', key: 'field_name', width: 28 },
      { header: 'role', key: 'role', width: 12 },
      { header: 'meaning', key: 'meaning', width: 48 },
      { header: 'unit', key: 'unit', width: 12 },
      { header: 'enum_values', key: 'enum_values', width: 36 },
      { header: 'enabled', key: 'enabled', width: 10 },
    ];
    for (const f of fields) {
      const enums = Array.isArray(f.enumValues)
        ? (f.enumValues as Array<{ value?: unknown; label?: unknown }>)
            .map((e) => {
              const value = typeof e.value === 'string' ? e.value : '';
              const label = typeof e.label === 'string' ? e.label : '';
              return label ? `${value}|${label}` : value;
            })
            .filter(Boolean)
            .join(',')
        : '';
      fs.addRow({
        datasource_id: f.datasourceId,
        table_name: f.tableName,
        field_name: f.fieldName,
        role: f.role,
        meaning: f.meaning,
        unit: f.unit ?? '',
        enum_values: enums,
        enabled: f.enabled ? 'true' : 'false',
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  static get XLSX_TYPE(): string {
    return XLSX_TYPE;
  }

  // ---- import -----------------------------------------------------------

  /** Excel import: rows from BOTH sheets; every row upserts at WORKSPACE. */
  async importExcel(buffer: Buffer): Promise<{
    applied: number;
    failed: Array<{ row: string; reason: string }>;
  }> {
    this.requireWorkspaceAdmin();
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException(tr('semantic.import_bad_file'));
    }
    const rows: Array<{ row: SemanticImportRow; label: string }> = [];
    const ts = wb.getWorksheet('table_semantics');
    if (ts) {
      ts.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // header
        rows.push({
          row: {
            entity_type: 'table',
            datasource_id: cellText(row.getCell(1).value),
            table_name: cellText(row.getCell(2).value),
            meaning: cellText(row.getCell(3).value),
          },
          label: `table#row${rowNumber}`,
        });
      });
    }
    const fs = wb.getWorksheet('field_semantics');
    if (fs) {
      fs.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        rows.push({
          row: {
            entity_type: 'field',
            datasource_id: cellText(row.getCell(1).value),
            table_name: cellText(row.getCell(2).value),
            field_name: cellText(row.getCell(3).value),
            role: cellText(row.getCell(4).value) || 'other',
            meaning: cellText(row.getCell(5).value),
            unit: cellText(row.getCell(6).value),
            enum_values: cellText(row.getCell(7).value),
          },
          label: `field#row${rowNumber}`,
        });
      });
    }
    return this.applyRows(
      rows.map((r) => r.row),
      rows.map((r) => r.label),
    );
  }

  /** JSON batch import (the authenticated /meta/semantic/import API). */
  async importJson(rows: SemanticImportRow[]): Promise<{
    applied: number;
    failed: Array<{ row: string; reason: string }>;
  }> {
    this.requireWorkspaceAdmin();
    return this.applyRows(
      rows,
      rows.map((_, i) => `row${i + 1}`),
    );
  }

  /** Row-by-row apply at WORKSPACE scope; one bad row never aborts the batch
   *  (reported back instead — same contract as terminology's error workbook,
   *  without the file round-trip: callers are machines or the admin UI). */
  private async applyRows(
    rows: SemanticImportRow[],
    labels: string[],
  ): Promise<{
    applied: number;
    failed: Array<{ row: string; reason: string }>;
  }> {
    let applied = 0;
    const failed: Array<{ row: string; reason: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const label = labels[i] ?? `row${i + 1}`;
      try {
        const info = this.toInfo(raw);
        await this.semanticService.upsert(info);
        applied += 1;
      } catch (e) {
        failed.push({
          row: label,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.logger.log(
      `semantic import: ${applied} applied, ${failed.length} failed`,
    );
    return { applied, failed };
  }

  private toInfo(raw: SemanticImportRow): SemanticUpsertInfo {
    const entityType =
      raw.entity_type === 'field' || raw.field_name ? 'field' : 'table';
    const dsId = Number(raw.datasource_id);
    if (!Number.isInteger(dsId) || dsId <= 0) {
      throw new BadRequestException(tr('semantic.missing_fields'));
    }
    if (!raw.table_name?.trim() || !raw.meaning?.trim()) {
      throw new BadRequestException(tr('semantic.missing_fields'));
    }
    const info: SemanticUpsertInfo = {
      entity_type: entityType,
      // Import always targets the WORKSPACE layer (admin-only path).
      scope: 'WORKSPACE',
      datasource_id: dsId,
      table_name: raw.table_name.trim(),
      meaning: raw.meaning.trim(),
      enabled: true,
    };
    if (entityType === 'field') {
      if (!raw.field_name?.trim()) {
        throw new BadRequestException(tr('semantic.missing_fields'));
      }
      info.field_name = raw.field_name.trim();
      const role = (raw.role ?? 'other').trim();
      info.role = (
        ['metric', 'dimension', 'time', 'other'].includes(role) ? role : 'other'
      ) as SemanticUpsertInfo['role'];
      if (raw.unit?.trim()) info.unit = raw.unit.trim();
      const enumText = (raw.enum_values ?? '').trim();
      if (enumText) {
        info.enum_values = enumText
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((pair) => {
            const [value, label] = pair.split('|');
            return label
              ? { value: value.trim(), label: label.trim() }
              : { value };
          });
      }
    }
    return info;
  }
}
