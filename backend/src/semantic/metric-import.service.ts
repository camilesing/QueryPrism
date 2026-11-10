// MetricImportService — the M4 ingestion paths: Excel export/import (six
// sheets: the five metric kinds + data standards) + the JSON batches used by
// the authenticated meta API (ApiKeyGuard). Rows default to the WORKSPACE
// layer and may carry an explicit `scope` + `enabled`; each row is written
// directly only when the actor may edit that layer (PERSONAL: own rows,
// WORKSPACE: workspace admin, GLOBAL: system admin). Unauthorized rows fail
// and are reported — bulk import never creates pending proposals. A PERSONAL
// export row re-imports into the IMPORTER's own personal layer (ownerUid is
// always derived from the actor, never the row).
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
  mergeImportSummaries,
  parseImportEnabled,
  parseImportScope,
  type ImportSummary,
} from './import-values';
import { MetricService, type MetricUpsertInfo } from './metric.service';
import {
  DataStandardService,
  type StandardUpsertInfo,
} from './standard.service';
import type { MetricKind, StandardKind } from './metric-policy';

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

const splitList = (text: string): string[] =>
  text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** One parsed metric row (Excel or JSON). Per-kind fields are assembled into
 *  the strict definition payload by toMetricInfo; malformed shapes fail in
 *  MetricService.validateInfo with i18n'd reasons. */
export interface MetricImportRow {
  kind?: string;
  code?: string;
  name?: string;
  aliases?: string | string[];
  description?: string | null;
  unit?: string | null;
  datasource_id?: number | string;
  table_name?: string;
  field_name?: string;
  aggregation?: string;
  operator?: string;
  values?: string | string[];
  mode?: string;
  time_unit?: string;
  count?: number | string;
  anchor?: string;
  atomic_code?: string;
  modifier_codes?: string | string[];
  period_code?: string;
  time_field?: string;
  expression?: string;
  enabled?: boolean | string;
  /** GLOBAL | WORKSPACE | PERSONAL; absent/empty → WORKSPACE. */
  scope?: string | null;
}

export interface StandardImportRow {
  kind?: string;
  code?: string;
  term?: string;
  name?: string;
  aliases?: string | string[];
  category?: string | null;
  description?: string | null;
  enabled?: boolean | string;
  /** GLOBAL | WORKSPACE | PERSONAL; absent/empty → WORKSPACE. */
  scope?: string | null;
}

@Injectable()
export class MetricImportService {
  private readonly logger = new Logger(MetricImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metricService: MetricService,
    private readonly standardService: DataStandardService,
  ) {}

  static get XLSX_TYPE(): string {
    return XLSX_TYPE;
  }

  private actor(): SemanticActor {
    const user = RequestContext.getUser();
    if (!user) throw new ForbiddenException(tr('metric.no_context_user'));
    return { id: user.id, oid: user.oid, weight: user.weight };
  }

  /** Direct-write authority check per row; `prefix` selects metric.* /
   *  standard.* i18n so a standards sheet reports in its own namespace. */
  private assertScopeAuthority(
    actor: SemanticActor,
    scope: SemanticScope,
    prefix: 'metric' | 'standard',
  ): void {
    if (!canEditDirect(actor, scope)) {
      throw new ForbiddenException(tr(`${prefix}.import_forbidden`));
    }
  }

  // ---- export -----------------------------------------------------------

  /** Export the actor-visible metric + standard rows (six sheets). */
  async exportAll(): Promise<Buffer> {
    const user = RequestContext.getUser();
    if (!user) throw new ForbiddenException(tr('metric.no_context_user'));
    const visible = {
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'WORKSPACE', oid: user.oid },
        { scope: 'PERSONAL', oid: user.oid, ownerUid: user.id },
      ],
    };
    const [metrics, standards] = await Promise.all([
      this.prisma.metricDef.findMany({
        where: visible,
        orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.dataStandard.findMany({
        where: visible,
        orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      }),
    ]);
    const wb = new ExcelJS.Workbook();
    const aliases = (a: unknown): string =>
      Array.isArray(a)
        ? a.filter((x): x is string => typeof x === 'string').join(',')
        : '';

    const def = (d: unknown): Record<string, unknown> =>
      d && typeof d === 'object' && !Array.isArray(d)
        ? (d as Record<string, unknown>)
        : {};
    /** Definition-field stringifier — a hand-corrupted nested object renders
     *  as '' instead of '[object Object]'. */
    const defStr = (v: unknown): string => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return '';
    };
    const defNum = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const sheets: Array<{
      name: string;
      columns: Array<{ header: string; key: string; width: number }>;
      rows: Array<Record<string, string | number>>;
    }> = [];
    for (const kind of [
      'atomic',
      'modifier',
      'period',
      'derived',
      'composite',
    ]) {
      const rows = metrics.filter((m) => m.kind === kind);
      const sheet: (typeof sheets)[number] = {
        name: {
          atomic: 'atomic_metrics',
          modifier: 'modifiers',
          period: 'time_periods',
          derived: 'derived_metrics',
          composite: 'composite_metrics',
        }[kind as Exclude<MetricKind, never>],
        columns: [
          { header: 'code', key: 'code', width: 22 },
          { header: 'name', key: 'name', width: 22 },
          { header: 'aliases', key: 'aliases', width: 26 },
          ...(kind === 'atomic' || kind === 'modifier'
            ? [
                { header: 'datasource_id', key: 'datasource_id', width: 14 },
                { header: 'table_name', key: 'table_name', width: 24 },
                { header: 'field_name', key: 'field_name', width: 22 },
              ]
            : []),
          ...(kind === 'atomic'
            ? [{ header: 'aggregation', key: 'aggregation', width: 16 }]
            : []),
          ...(kind === 'modifier'
            ? [
                { header: 'operator', key: 'operator', width: 12 },
                { header: 'values', key: 'values', width: 28 },
              ]
            : []),
          ...(kind === 'period'
            ? [
                { header: 'mode', key: 'mode', width: 10 },
                { header: 'time_unit', key: 'time_unit', width: 10 },
                { header: 'count', key: 'count', width: 8 },
                { header: 'anchor', key: 'anchor', width: 12 },
              ]
            : []),
          ...(kind === 'derived'
            ? [
                { header: 'atomic_code', key: 'atomic_code', width: 22 },
                { header: 'modifier_codes', key: 'modifier_codes', width: 28 },
                { header: 'period_code', key: 'period_code', width: 22 },
                { header: 'time_field', key: 'time_field', width: 22 },
              ]
            : []),
          ...(kind === 'composite'
            ? [{ header: 'expression', key: 'expression', width: 40 }]
            : []),
          ...(kind === 'atomic'
            ? [{ header: 'unit', key: 'unit', width: 10 }]
            : []),
          { header: 'description', key: 'description', width: 36 },
          { header: 'enabled', key: 'enabled', width: 10 },
          { header: 'scope', key: 'scope', width: 12 },
        ],
        rows: rows.map((m) => {
          const d = def(m.definition);
          const out: Record<string, string | number> = {
            code: m.code,
            name: m.name,
            aliases: aliases(m.aliases),
          };
          if (kind === 'atomic' || kind === 'modifier') {
            out.datasource_id = defNum(d.datasource_id);
            out.table_name = defStr(d.table_name);
            out.field_name = defStr(d.field_name);
          }
          if (kind === 'atomic') out.aggregation = defStr(d.aggregation);
          if (kind === 'modifier') {
            out.operator = defStr(d.operator);
            out.values = Array.isArray(d.values)
              ? (d.values as unknown[])
                  .map((v) => defStr(v))
                  .filter(Boolean)
                  .join(',')
              : '';
          }
          if (kind === 'period') {
            out.mode = defStr(d.mode);
            out.time_unit = defStr(d.time_unit);
            out.count = defNum(d.count);
            out.anchor = defStr(d.anchor);
          }
          if (kind === 'derived') {
            out.atomic_code = defStr(d.atomic_code);
            out.modifier_codes = Array.isArray(d.modifier_codes)
              ? (d.modifier_codes as unknown[])
                  .map((v) => defStr(v))
                  .filter(Boolean)
                  .join(',')
              : '';
            out.period_code = defStr(d.period_code);
            out.time_field = defStr(d.time_field);
          }
          if (kind === 'composite') out.expression = defStr(d.expression);
          if (kind === 'atomic') out.unit = m.unit ?? '';
          out.description = m.description ?? '';
          out.enabled = m.enabled ? 'true' : 'false';
          out.scope = m.scope;
          return out;
        }),
      };
      sheets.push(sheet);
    }
    sheets.push({
      name: 'data_standards',
      columns: [
        { header: 'kind', key: 'kind', width: 10 },
        { header: 'code', key: 'code', width: 22 },
        { header: 'term', key: 'term', width: 22 },
        { header: 'name', key: 'name', width: 22 },
        { header: 'aliases', key: 'aliases', width: 26 },
        { header: 'category', key: 'category', width: 16 },
        { header: 'description', key: 'description', width: 36 },
        { header: 'enabled', key: 'enabled', width: 10 },
        { header: 'scope', key: 'scope', width: 12 },
      ],
      rows: standards.map((s) => ({
        kind: s.kind,
        code: s.code,
        term: s.term,
        name: s.name,
        aliases: aliases(s.aliases),
        category: s.category ?? '',
        description: s.description ?? '',
        enabled: s.enabled ? 'true' : 'false',
        scope: s.scope,
      })),
    });
    for (const sheet of sheets) {
      const ws = wb.addWorksheet(sheet.name);
      ws.columns = sheet.columns;
      for (const row of sheet.rows) ws.addRow(row);
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // ---- import -----------------------------------------------------------

  /** Excel import: rows from all six sheets; each row upserts into its own
   *  scope (missing scope column → WORKSPACE; enabled columns are honored). */
  async importExcel(buffer: Buffer): Promise<ImportSummary> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new BadRequestException(tr('metric.import_bad_file'));
    }
    const metricRows: Array<{ row: MetricImportRow; label: string }> = [];
    const standardRows: Array<{ row: StandardImportRow; label: string }> = [];
    /** Positional reader: skip the header, hand data rows to cb. */
    const eachRow = (name: string, cb: (r: ExcelJS.Row) => void): void => {
      const ws = wb.getWorksheet(name);
      if (!ws) return;
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // header
        cb(row);
      });
    };
    eachRow('atomic_metrics', (r) =>
      metricRows.push({
        row: {
          kind: 'atomic',
          code: cellText(r.getCell(1).value),
          name: cellText(r.getCell(2).value),
          aliases: cellText(r.getCell(3).value),
          datasource_id: cellText(r.getCell(4).value),
          table_name: cellText(r.getCell(5).value),
          field_name: cellText(r.getCell(6).value),
          aggregation: cellText(r.getCell(7).value),
          unit: cellText(r.getCell(8).value),
          description: cellText(r.getCell(9).value),
          enabled: cellText(r.getCell(10).value),
          scope: cellText(r.getCell(11).value),
        },
        label: `atomic#row${r.number}`,
      }),
    );
    eachRow('modifiers', (r) =>
      metricRows.push({
        row: {
          kind: 'modifier',
          code: cellText(r.getCell(1).value),
          name: cellText(r.getCell(2).value),
          aliases: cellText(r.getCell(3).value),
          datasource_id: cellText(r.getCell(4).value),
          table_name: cellText(r.getCell(5).value),
          field_name: cellText(r.getCell(6).value),
          operator: cellText(r.getCell(7).value),
          values: cellText(r.getCell(8).value),
          description: cellText(r.getCell(9).value),
          enabled: cellText(r.getCell(10).value),
          scope: cellText(r.getCell(11).value),
        },
        label: `modifier#row${r.number}`,
      }),
    );
    eachRow('time_periods', (r) =>
      metricRows.push({
        row: {
          kind: 'period',
          code: cellText(r.getCell(1).value),
          name: cellText(r.getCell(2).value),
          aliases: cellText(r.getCell(3).value),
          mode: cellText(r.getCell(4).value),
          time_unit: cellText(r.getCell(5).value),
          count: cellText(r.getCell(6).value),
          anchor: cellText(r.getCell(7).value),
          description: cellText(r.getCell(8).value),
          enabled: cellText(r.getCell(9).value),
          scope: cellText(r.getCell(10).value),
        },
        label: `period#row${r.number}`,
      }),
    );
    eachRow('derived_metrics', (r) =>
      metricRows.push({
        row: {
          kind: 'derived',
          code: cellText(r.getCell(1).value),
          name: cellText(r.getCell(2).value),
          aliases: cellText(r.getCell(3).value),
          atomic_code: cellText(r.getCell(4).value),
          modifier_codes: cellText(r.getCell(5).value),
          period_code: cellText(r.getCell(6).value),
          time_field: cellText(r.getCell(7).value),
          description: cellText(r.getCell(8).value),
          enabled: cellText(r.getCell(9).value),
          scope: cellText(r.getCell(10).value),
        },
        label: `derived#row${r.number}`,
      }),
    );
    eachRow('composite_metrics', (r) =>
      metricRows.push({
        row: {
          kind: 'composite',
          code: cellText(r.getCell(1).value),
          name: cellText(r.getCell(2).value),
          aliases: cellText(r.getCell(3).value),
          expression: cellText(r.getCell(4).value),
          description: cellText(r.getCell(5).value),
          enabled: cellText(r.getCell(6).value),
          scope: cellText(r.getCell(7).value),
        },
        label: `composite#row${r.number}`,
      }),
    );
    eachRow('data_standards', (r) =>
      standardRows.push({
        row: {
          kind: cellText(r.getCell(1).value),
          code: cellText(r.getCell(2).value),
          term: cellText(r.getCell(3).value),
          name: cellText(r.getCell(4).value),
          aliases: cellText(r.getCell(5).value),
          category: cellText(r.getCell(6).value),
          description: cellText(r.getCell(7).value),
          enabled: cellText(r.getCell(8).value),
          scope: cellText(r.getCell(9).value),
        },
        label: `standard#row${r.number}`,
      }),
    );
    const [metricOut, standardOut] = await Promise.all([
      this.applyMetricRows(
        metricRows.map((r) => r.row),
        metricRows.map((r) => r.label),
      ),
      this.applyStandardRows(
        standardRows.map((r) => r.row),
        standardRows.map((r) => r.label),
      ),
    ]);
    return mergeImportSummaries(metricOut, standardOut);
  }

  /** JSON batch import (the authenticated /meta/metric/import API). */
  async importJsonMetrics(rows: MetricImportRow[]): Promise<ImportSummary> {
    return this.applyMetricRows(
      rows,
      rows.map((_, i) => `row${i + 1}`),
    );
  }

  /** JSON batch import (the authenticated /meta/standard/import API). */
  async importJsonStandards(rows: StandardImportRow[]): Promise<ImportSummary> {
    return this.applyStandardRows(
      rows,
      rows.map((_, i) => `row${i + 1}`),
    );
  }

  private async applyMetricRows(
    rows: MetricImportRow[],
    labels: string[],
  ): Promise<ImportSummary> {
    const actor = this.actor();
    let applied = 0;
    const byScope = emptyScopeCounts();
    const failed: ImportSummary['failed'] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const info = this.toMetricInfo(rows[i]);
        this.assertScopeAuthority(actor, info.scope, 'metric');
        const result = await this.metricService.upsert(info);
        if (!result.applied) {
          throw new ForbiddenException(tr('metric.import_forbidden'));
        }
        applied += 1;
        byScope[info.scope] += 1;
      } catch (e) {
        failed.push({
          row: labels[i] ?? `row${i + 1}`,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.logger.log(
      `metric import: ${applied} applied, ${failed.length} failed`,
    );
    return { applied, by_scope: byScope, failed };
  }

  private async applyStandardRows(
    rows: StandardImportRow[],
    labels: string[],
  ): Promise<ImportSummary> {
    const actor = this.actor();
    let applied = 0;
    const byScope = emptyScopeCounts();
    const failed: ImportSummary['failed'] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const info = this.toStandardInfo(rows[i]);
        this.assertScopeAuthority(actor, info.scope, 'standard');
        const result = await this.standardService.upsert(info);
        if (!result.applied) {
          throw new ForbiddenException(tr('standard.import_forbidden'));
        }
        applied += 1;
        byScope[info.scope] += 1;
      } catch (e) {
        failed.push({
          row: labels[i] ?? `row${i + 1}`,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.logger.log(
      `standard import: ${applied} applied, ${failed.length} failed`,
    );
    return { applied, by_scope: byScope, failed };
  }

  private toMetricInfo(raw: MetricImportRow): MetricUpsertInfo {
    const scope = parseImportScope(raw.scope);
    if (!scope) throw new BadRequestException(tr('metric.invalid_scope'));
    const kind = (raw.kind ?? '').trim() as MetricKind;
    const list = (v: string | string[] | undefined): string[] | undefined => {
      if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
      const parts = splitList(v ?? '');
      return parts.length > 0 ? parts : undefined;
    };
    const dsId = Number(raw.datasource_id);
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const base = {
      kind,
      scope,
      code: (raw.code ?? '').trim(),
      name: (raw.name ?? '').trim(),
      aliases: list(raw.aliases),
      description: raw.description?.trim() || undefined,
      enabled: parseImportEnabled(raw.enabled),
    };
    switch (kind) {
      case 'atomic':
        return {
          ...base,
          unit: raw.unit?.trim() || undefined,
          definition: {
            datasource_id: dsId,
            table_name: (raw.table_name ?? '').trim(),
            field_name: (raw.field_name ?? '').trim(),
            aggregation: (raw.aggregation ?? '').trim(),
          },
        };
      case 'modifier':
        return {
          ...base,
          definition: {
            datasource_id: dsId,
            table_name: (raw.table_name ?? '').trim(),
            field_name: (raw.field_name ?? '').trim(),
            operator: (raw.operator ?? '').trim(),
            values: list(raw.values) ?? [],
          },
        };
      case 'period': {
        const mode = (raw.mode ?? 'recent').trim();
        return {
          ...base,
          definition: {
            mode,
            ...(mode === 'anchor'
              ? { anchor: (raw.anchor ?? '').trim() }
              : {
                  time_unit: (raw.time_unit ?? '').trim(),
                  count: num(raw.count),
                }),
          },
        };
      }
      case 'derived':
        return {
          ...base,
          definition: {
            atomic_code: (raw.atomic_code ?? '').trim(),
            modifier_codes: list(raw.modifier_codes),
            period_code: raw.period_code?.trim() || undefined,
            time_field: raw.time_field?.trim() || undefined,
          },
        };
      case 'composite':
        return {
          ...base,
          definition: {
            expression: (raw.expression ?? '').trim(),
          },
        };
      default:
        throw new BadRequestException(tr('metric.invalid_kind'));
    }
  }

  private toStandardInfo(raw: StandardImportRow): StandardUpsertInfo {
    const scope = parseImportScope(raw.scope);
    if (!scope) throw new BadRequestException(tr('standard.invalid_scope'));
    return {
      kind: (raw.kind ?? '').trim() as StandardKind,
      scope,
      code: (raw.code ?? '').trim(),
      term: (raw.term ?? '').trim(),
      name: (raw.name ?? '').trim(),
      aliases: Array.isArray(raw.aliases)
        ? raw.aliases.map((s) => s.trim()).filter(Boolean)
        : splitList(raw.aliases ?? ''),
      category: raw.category?.trim() || undefined,
      description: raw.description?.trim() || undefined,
      enabled: parseImportEnabled(raw.enabled),
    };
  }
}
