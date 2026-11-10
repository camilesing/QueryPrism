// SemanticImportService — the M2 ingestion paths: Excel export/import (admin
// surface, terminology pattern) + the JSON batch used by the authenticated
// meta API (ApiKeyGuard). Rows default to the WORKSPACE layer and may carry
// an explicit `scope` (GLOBAL/WORKSPACE/PERSONAL) + `enabled`; each row is
// written directly only when the actor may edit that layer (PERSONAL: own
// rows, WORKSPACE: workspace admin, GLOBAL: system admin) — an unauthorized
// row fails and is reported, it never silently becomes a pending proposal.
// Known limitation: a PERSONAL export row re-imports into the IMPORTER's own
// personal layer (ownerUid is always derived from the actor, never the row).
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
import {
  canEditDirect,
  type SemanticActor,
  type SemanticScope,
} from './semantic-policy';
import {
  emptyScopeCounts,
  parseImportEnabled,
  parseImportScope,
  type ImportSummary,
} from './import-values';
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
  /** GLOBAL | WORKSPACE | PERSONAL; absent/empty → WORKSPACE. */
  scope?: string | null;
  /** Excel text or JSON boolean; false/'false'/'0' disables. */
  enabled?: boolean | string | null;
}

@Injectable()
export class SemanticImportService {
  private readonly logger = new Logger(SemanticImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly semanticService: SemanticService,
  ) {}

  private actor(): SemanticActor {
    const user = RequestContext.getUser();
    if (!user) throw new ForbiddenException(tr('semantic.no_context_user'));
    return { id: user.id, oid: user.oid, weight: user.weight };
  }

  /** Direct-write authority check per row (no bulk approval routing). */
  private assertScopeAuthority(
    actor: SemanticActor,
    scope: SemanticScope,
  ): void {
    if (!canEditDirect(actor, scope)) {
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
      { header: 'scope', key: 'scope', width: 12 },
    ];
    for (const t of tables) {
      ts.addRow({
        datasource_id: t.datasourceId,
        table_name: t.tableName,
        meaning: t.meaning,
        enabled: t.enabled ? 'true' : 'false',
        scope: t.scope,
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
      { header: 'scope', key: 'scope', width: 12 },
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
        scope: f.scope,
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  static get XLSX_TYPE(): string {
    return XLSX_TYPE;
  }

  // ---- import -----------------------------------------------------------

  /** Excel import: rows from BOTH sheets; each row upserts into its own scope
   *  (missing scope column → WORKSPACE; enabled column is now honored). */
  async importExcel(buffer: Buffer): Promise<ImportSummary> {
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
            enabled: cellText(row.getCell(4).value),
            scope: cellText(row.getCell(5).value),
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
            enabled: cellText(row.getCell(8).value),
            scope: cellText(row.getCell(9).value),
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
  async importJson(rows: SemanticImportRow[]): Promise<ImportSummary> {
    return this.applyRows(
      rows,
      rows.map((_, i) => `row${i + 1}`),
    );
  }

  /** Row-by-row apply; one bad row (bad scope, no authority, validation)
   *  never aborts the batch — it is reported back instead. Unauthorized rows
   *  fail rather than becoming pending change requests, so a bulk import can
   *  never flood the approval inbox. */
  private async applyRows(
    rows: SemanticImportRow[],
    labels: string[],
  ): Promise<ImportSummary> {
    const actor = this.actor();
    let applied = 0;
    const byScope = emptyScopeCounts();
    const failed: ImportSummary['failed'] = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const label = labels[i] ?? `row${i + 1}`;
      try {
        const info = this.toInfo(raw);
        this.assertScopeAuthority(actor, info.scope);
        const result = await this.semanticService.upsert(info);
        if (!result.applied) {
          throw new ForbiddenException(tr('semantic.import_forbidden'));
        }
        applied += 1;
        byScope[info.scope] += 1;
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
    return { applied, by_scope: byScope, failed };
  }

  private toInfo(raw: SemanticImportRow): SemanticUpsertInfo {
    const scope = parseImportScope(raw.scope);
    if (!scope) throw new BadRequestException(tr('semantic.invalid_scope'));
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
      scope,
      datasource_id: dsId,
      table_name: raw.table_name.trim(),
      meaning: raw.meaning.trim(),
      enabled: parseImportEnabled(raw.enabled),
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
