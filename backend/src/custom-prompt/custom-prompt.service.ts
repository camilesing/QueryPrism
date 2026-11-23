// CustomPromptService — per-type custom-prompt CRUD (snake_case wire
// shape) + POST-body list filters + Excel import/export. Implemented from
// the frontend contract (api/prompt.ts + views/system/prompt/index.vue).
//
// type: GENERATE_SQL | ANALYSIS | PREDICT_DATA — single table filtered by
// type (kept as String + validated at the controller boundary via the path
// segment). No AES (prompt is plaintext).
// No embedding (the chat pipeline uses find_custom_prompts directly, not a
// vector index). advancedApplication is a stringified Assistant.id (kept as
// String? + coerced on read).
//
// Excel import/export uses the shared import helpers (exceljs; cellText
// coerces rich-text/formula cells to strings). List filter contract:
// page + export are POSTs whose JSON body carries
// `{ name?, ds_list?: number[], adv_list?: number[] }` — the pre-upgrade
// non-standard `?name=foo_5_12&dslist=5_12` underscore-bundled GET query is
// REPLACED (the frontend posts a plain object via request.post(url, params)).
// Filter semantics:
// ds match = specific_ds=false OR (specific_ds=true AND datasource_ids hits
// one of ds_list); adv match = advanced_application IN adv_list; all
// conditions AND-combined.
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type CustomPrompt } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { ImportErrorFileService } from '../common/import-export/import-error-file.service';
// P3-3: the ds/adv filter + name-map + cellText helpers live in the shared
// import-export helpers so feature modules cannot drift.
import {
  applyDsAdvFilters,
  buildAdvancedAppNamesMap,
  buildAssistantNameToIdMap,
  buildDatasourceNameToIdMap,
  buildDatasourceNamesMap,
  cellText,
} from '../common/import-export/helpers';
import { parseStrictInt } from '../common/utils/parse-int';
import {
  toCustomPromptSnake,
  type CustomPromptRow,
  type CustomPromptSnake,
} from './custom-prompt-snake-mapper';
import { tr } from '../common/i18n/translate';

/** PUT /system/custom_prompt body — snake_case (frontend sends these field
 *  names). Plain interface (no DTO class) → ValidationPipe passthrough (§101).
 *  `id` present → update; absent → create. `datasource_names` +
 *  `advanced_application_name` are accepted for parity but ignored on write
 *  (derived on read). `advanced_application` is a number on the wire (the
 *  el-select binds to the numeric assistant id); stored as a string. */
export interface CustomPromptInfo {
  id?: number;
  type: string;
  name: string;
  prompt?: string;
  specific_ds?: boolean;
  datasource_ids?: number[];
  datasource_names?: string[];
  advanced_application?: number | null;
  advanced_application_name?: string | null;
}

/** GET /system/custom_prompt/:type/page/:n/:s response — the full pager
 *  shape. The frontend reads only `data` + `total_count`; the extra fields
 *  are harmless wire-compat extras (mirrors terminology TerminologyPage). */
export interface CustomPromptPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: CustomPromptSnake[];
}

/** POST /system/custom_prompt/:type/uploadExcel response — the shape the
 *  el-upload `onSuccess(response)` reads as `response.data.*` (el-upload does
 *  its own XHR, so the global TransformInterceptor envelope wraps this; the
 *  Uploader reads `response.data.success_count` / `failed_count` /
 *  `error_excel_filename`). */
export interface CustomPromptImportResult {
  success_count: number;
  failed_count: number;
  duplicate_count: number;
  original_count: number;
  error_excel_filename: string | null;
}

/** POST /system/custom_prompt/:type/page/:n/:s and /export body — the
 *  list-filter contract. The frontend's
 *  configParams() builds `{ name?: keyword, ds_list?: number[],
 *  adv_list?: number[] }` and posts it via request.post. Plain interface (no
 *  DTO class) → ValidationPipe passthrough. */
export interface CustomPromptQueryFilters {
  name?: string;
  ds_list?: number[];
  adv_list?: number[];
}

/** Coerce a filter body's loose `ds_list`/`adv_list` entries (numbers, or
 *  strings when hand-crafted) into a clean number[]. P2-1: strict parse —
 *  the old `Number()` + NaN filter turned null/''/true into 0/1,
 *  fabricating datasource ids that silently matched the wrong rows. */
function toIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const parsed = parseStrictInt(v);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

@Injectable()
export class CustomPromptService {
  private readonly logger = new Logger(CustomPromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly importError: ImportErrorFileService,
  ) {}

  // ──────────────────────────── CRUD (parity) ────────────────────────────

  /** POST /system/custom_prompt/:type/page/:n/:s — paginated per-type list.
   *  `filters` is the POST body `{ name?, ds_list?, adv_list? }`. `name` is a
   *  keyword (name/prompt contains); dsList/
   *  advList are in-memory post-filters (JSON-array containment is kept in JS
   *  for portability — same approach as terminology). ds semantics mirror
   *  terminology: specific_ds=false matches (applies to all
   *  datasources) OR (specific_ds=true AND datasource_ids hits dsList); adv =
   *  advancedApplication IN advList (String? column → stringified); AND-
   *  combined. Returns the full pager shape. */
  async page(
    type: string,
    currentPage: number,
    pageSize: number,
    filters?: CustomPromptQueryFilters,
  ): Promise<CustomPromptPage> {
    const oid = this.currentOid();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(1, Math.floor(pageSize));
    const keyword = filters?.name?.trim() ?? '';
    const dsIds = toIdList(filters?.ds_list);
    const advIds = toIdList(filters?.adv_list);
    const where: Prisma.CustomPromptWhereInput = { oid, type };
    if (keyword) {
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { prompt: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.customPrompt.findMany({
      where,
      orderBy: { createTime: 'desc' },
    });
    const filtered = applyDsAdvFilters(rows, dsIds, advIds);
    const total_count = filtered.length;
    const total_pages = total_count > 0 ? Math.ceil(total_count / ps) : 0;
    const cpClamped = total_pages > 0 ? Math.min(cp, total_pages) : 1;
    const start = (cpClamped - 1) * ps;
    const pageRows = filtered.slice(start, start + ps);

    const datasourceNamesMap = await buildDatasourceNamesMap(
      this.prisma,
      pageRows,
      this.currentOid(),
    );
    const advancedAppNamesMap = await buildAdvancedAppNamesMap(
      this.prisma,
      pageRows,
      this.currentOid(),
    );
    return {
      current_page: cpClamped,
      page_size: ps,
      total_count,
      total_pages,
      data: pageRows.map((r) =>
        toCustomPromptSnake(
          r as CustomPromptRow,
          datasourceNamesMap,
          advancedAppNamesMap,
        ),
      ),
    };
  }

  /** PUT /system/custom_prompt — create (no id) or update (with id). Body is
   *  the snake_case CustomPromptInfo (plain interface, no DTO class →
   *  ValidationPipe passthrough, §101). Returns the raw row (the @SystemLog
   *  resources callback reads name+id). `advanced_application` (number on the
   *  wire) is stringified for storage. */
  async upsert(info: CustomPromptInfo): Promise<CustomPrompt> {
    const oid = this.currentOid();
    if (!info.name || !info.name.trim()) {
      throw new BadRequestException(tr('custom-prompt.name_required'));
    }
    const name = info.name.trim();
    const prompt = info.prompt?.trim() || null;
    const specificDs = info.specific_ds ?? false;
    const datasourceIds = Array.isArray(info.datasource_ids)
      ? [...new Set(info.datasource_ids)]
      : [];
    if (datasourceIds.length > 0) {
      const found = await this.prisma.datasource.count({
        where: { id: { in: datasourceIds }, oid },
      });
      if (found !== datasourceIds.length) {
        throw new BadRequestException(
          '提示词引用的数据源不存在或不属于当前工作空间',
        );
      }
    }
    const type = info.type;
    const advancedApplication =
      info.advanced_application != null
        ? String(info.advanced_application)
        : null;

    if (info.id) {
      // Verify ownership (throws NotFound if the id isn't in this workspace).
      await this.findOneOrFail(info.id);
      return this.prisma.customPrompt.update({
        where: { id: info.id },
        data: {
          type,
          name,
          prompt,
          specificDs,
          datasourceIds: this.jsonIds(datasourceIds),
          advancedApplication,
        },
      });
    }
    return this.prisma.customPrompt.create({
      data: {
        oid,
        type,
        name,
        prompt,
        specificDs,
        datasourceIds: this.jsonIds(datasourceIds),
        advancedApplication,
      },
    });
  }

  /** DELETE /system/custom_prompt — batch delete by id. Body is a BARE ARRAY
   *  `[id1, id2, ...]` (the frontend sends `multipleSelectionAll.map(e => e.id)`
   *  as `{ data: params }`). oid-scoped deleteMany. Returns the ids for the
   *  @SystemLog resources callback (mirrors terminology §105). */
  async remove(ids: number[]): Promise<{ id: number }[]> {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const oid = this.currentOid();
    await this.prisma.customPrompt.deleteMany({
      where: { id: { in: ids }, oid },
    });
    return ids.map((id) => ({ id }));
  }

  // ─────────────────────────── Excel export/template ────────────────────────

  /** POST /system/custom_prompt/:type/export — xlsx of the FILTERED rows (no
   *  pagination; export honors the same name/ds_list/adv_list
   *  body filters as page). 5 columns: name,
   *  prompt, specific_ds, datasource, advanced_application_name. The
   *  controller streams the buffer via @Res() (bypasses TransformInterceptor). */
  async exportAll(
    type: string,
    filters?: CustomPromptQueryFilters,
  ): Promise<Buffer> {
    const oid = this.currentOid();
    const keyword = filters?.name?.trim() ?? '';
    const dsIds = toIdList(filters?.ds_list);
    const advIds = toIdList(filters?.adv_list);
    const where: Prisma.CustomPromptWhereInput = { oid, type };
    if (keyword) {
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { prompt: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    const allRows = await this.prisma.customPrompt.findMany({
      where,
      orderBy: { createTime: 'desc' },
    });
    const rows = applyDsAdvFilters(allRows, dsIds, advIds);
    const datasourceNamesMap = await buildDatasourceNamesMap(
      this.prisma,
      rows,
      this.currentOid(),
    );
    const advancedAppNamesMap = await buildAdvancedAppNamesMap(
      this.prisma,
      rows,
      this.currentOid(),
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('custom_prompt');
    ws.columns = [
      { header: tr('custom-prompt.col_name'), key: 'name', width: 24 },
      { header: tr('custom-prompt.col_content'), key: 'prompt', width: 60 },
      { header: '是否限定数据源', key: 'specific_ds', width: 14 },
      { header: tr('common.col_effective_ds'), key: 'datasource', width: 24 },
      {
        header: tr('common.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    for (const r of rows) {
      const snake = toCustomPromptSnake(
        r as CustomPromptRow,
        datasourceNamesMap,
        advancedAppNamesMap,
      );
      ws.addRow({
        name: snake.name ?? '',
        prompt: snake.prompt ?? '',
        specific_ds: snake.specific_ds ? 'Y' : 'N',
        datasource: snake.specific_ds ? snake.datasource_names.join(', ') : '',
        advanced_application_name: snake.advanced_application_name ?? '',
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** GET /system/custom_prompt/template — xlsx with 1 example row + the same 5
   *  column headers as the export. Headers are hardcoded
   *  Chinese (no backend i18n — same as terminology);
   *  the example prompt row is English so anything imported into the system
   *  prompt joins the English prompt corpus. */
  getTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('custom_prompt');
    ws.columns = [
      { header: tr('custom-prompt.col_name'), key: 'name', width: 24 },
      { header: tr('custom-prompt.col_content'), key: 'prompt', width: 60 },
      { header: '是否限定数据源', key: 'specific_ds', width: 14 },
      { header: tr('common.col_effective_ds'), key: 'datasource', width: 24 },
      {
        header: tr('common.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    ws.addRow({
      name: 'Example SQL prompt',
      prompt: 'Generate a SQL query for the user question: {{question}}',
      specific_ds: 'N',
      datasource: '',
      advanced_application_name: '',
    });
    return wb.xlsx.writeBuffer().then((buf) => Buffer.from(buf));
  }

  // ─────────────────────────── Excel import (uploadExcel) ────────────────────

  /** POST /system/custom_prompt/:type/uploadExcel — parse the uploaded xlsx,
   *  validate each row, upsert valid prompts, collect failures. 5 columns
   *  (1-indexed): name | prompt | specific_ds | datasource | advanced_application_name.
   *  `datasource` is a comma-joined list of datasource NAMES (resolved to ids
   *  via a batch lookup); `specific_ds` Y/yes/true → specificDs=true. `type`
   *  comes from the path segment (not the Excel column). Returns the summary
   *  the el-upload `onSuccess(response)` reads as `response.data.*`. Failed
   *  rows are written to `error_excel_filename` for POST
   *  /system/download-fail-info. */
  async importExcel(
    type: string,
    buffer: Buffer,
  ): Promise<CustomPromptImportResult> {
    const oid = this.currentOid();
    const wb = new ExcelJS.Workbook();
    type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
    // P2-4: a corrupt upload used to surface as an unhandled 500 from deep
    // inside exceljs — wrap with actionable context.
    try {
      await wb.xlsx.load(buffer as unknown as LoadParam);
    } catch (e) {
      throw new BadRequestException(
        `Excel 文件解析失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const ws = wb.getWorksheet('custom_prompt') ?? wb.worksheets[0];
    if (!ws) {
      return {
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      };
    }
    const datasourceNameToId = await buildDatasourceNameToIdMap(
      this.prisma,
      this.currentOid(),
    );
    const assistantNameToId = await buildAssistantNameToIdMap(this.prisma, oid);

    const records: CustomPromptInfo[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return; // header
      const name = cellText(row.getCell(1).value).trim();
      if (!name) return; // skip blank rows; counted neither way
      const prompt = cellText(row.getCell(2).value).trim();
      const specificDsRaw = cellText(row.getCell(3).value).trim().toLowerCase();
      const datasourceNamesRaw = cellText(row.getCell(4).value).trim();
      const advancedAppName = cellText(row.getCell(5).value).trim();
      const specificDs =
        specificDsRaw === 'y' ||
        specificDsRaw === 'yes' ||
        specificDsRaw === 'true';
      const datasource_names = datasourceNamesRaw
        ? datasourceNamesRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      records.push({
        type,
        name,
        prompt: prompt || undefined,
        specific_ds: specificDs,
        datasource_names,
        advanced_application_name: advancedAppName || null,
      });
    });

    // P2-4: natural-key upsert — preload EVERY (name → id) for this file in
    // one query. The old loop always created (Excel rows carry no id), so
    // re-importing a file duplicated every row.
    const existingByName = new Map<string, number>();
    if (records.length > 0) {
      const rows = await this.prisma.customPrompt.findMany({
        where: {
          oid,
          type,
          name: { in: records.map((r) => r.name) },
        },
        select: { id: true, name: true },
      });
      rows.forEach((r) => existingByName.set(r.name!, r.id));
    }

    let successCount = 0;
    let duplicateCount = 0;
    const failures: { info: CustomPromptInfo; message: string }[] = [];
    for (const info of records) {
      try {
        if (info.specific_ds) {
          const ids: number[] = [];
          for (const name of info.datasource_names ?? []) {
            const id = datasourceNameToId.get(name);
            if (id == null) {
              throw new Error(tr('common.ds_named_not_found', { name }));
            }
            ids.push(id);
          }
          info.datasource_ids = ids;
        } else {
          info.datasource_ids = [];
        }
        // P2-4: advanced_application resolves REGARDLESS of specific_ds —
        // dropping it when specific_ds=false was silent data loss on every
        // re-export/re-import round-trip.
        if (info.advanced_application_name) {
          const aid = assistantNameToId.get(info.advanced_application_name);
          if (aid == null) {
            throw new Error(
              `高级应用「${info.advanced_application_name}」不存在`,
            );
          }
          info.advanced_application = aid;
        }
        const existingId = existingByName.get(info.name);
        if (existingId != null) {
          info.id = existingId; // upsert takes its update path
          duplicateCount++;
        }
        await this.upsert(info);
        successCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ info, message });
        this.logger.warn(`custom_prompt import row skipped: ${message}`);
      }
    }
    let errorFilename: string | null = null;
    if (failures.length > 0) {
      errorFilename = await this.importError.write({
        prefix: 'custom-prompt',
        headers: ['名称', '提示词', '指定数据源', '数据源', '高级应用'],
        rows: failures.map(({ info }) => [
          info.name,
          info.prompt ?? '',
          info.specific_ds ? 'Y' : 'N',
          info.specific_ds ? (info.datasource_names ?? []).join(', ') : '',
          info.advanced_application_name ?? '',
        ]),
        messages: failures.map((f) => f.message),
      });
    }
    return {
      success_count: successCount,
      failed_count: failures.length,
      duplicate_count: duplicateCount,
      original_count: records.length,
      error_excel_filename: errorFilename,
    };
  }

  /** Runtime custom_prompt matching for the chat pipeline. Returns
   *  {customPromptText, promptList} — the text is the concatenated prompt
   *  bodies that flow into the NL2SQL system prompt (wired in
   *  ai-question.service.buildSqlContext); promptList is the raw matched
   *  rows for the messages-column log.
   *
   *  Matching (mutually-exclusive branches — assistant runs pass no
   *  datasource):
   *  - assistantId provided: match where advancedApplication ===
   *    String(assistantId); dsId is IGNORED.
   *  - otherwise (regular datasource run): match where specificDs===false
   *    (global) OR (specificDs===true AND datasourceIds includes dsId).
   *  Rows come back id-ASC (creation order) → the concatenation order. */
  async findCustomPrompts(
    type: string,
    oid: number,
    dsId?: number,
    assistantId?: number,
  ): Promise<{ customPromptText: string; promptList: CustomPrompt[] }> {
    const rows = await this.prisma.customPrompt.findMany({
      where: { type, oid },
      orderBy: { id: 'asc' },
    });
    const matched = rows.filter((p) => {
      if (assistantId !== undefined) {
        return p.advancedApplication === String(assistantId);
      }
      if (!p.specificDs) return true; // global — applies to every datasource
      if (dsId === undefined) return false;
      return (
        Array.isArray(p.datasourceIds) &&
        p.datasourceIds.some((v) => v === dsId)
      );
    });
    const customPromptText = matched
      .map((p) => p.prompt)
      .filter((v): v is string => !!v && v.trim().length > 0)
      .join('\n\n');
    return { customPromptText, promptList: matched };
  }

  // ─────────────────────────── helpers ────────────────────────────

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private async findOneOrFail(id: number): Promise<CustomPrompt> {
    const oid = this.currentOid();
    const row = await this.prisma.customPrompt.findFirst({
      where: { id, oid },
    });
    if (!row)
      throw new NotFoundException(tr('custom-prompt.prompt_not_found', { id }));
    return row;
  }

  /** Prisma JSON columns can't store a JS `null` directly — empty → the
   *  JsonNull sentinel so a missing datasourceIds persists as SQL NULL;
   *  non-empty → the number[] (InputJsonValue). Mirrors terminology §105. */
  private jsonIds(ids: number[]): Prisma.NullableJsonNullValueInput | number[] {
    return ids.length === 0 ? Prisma.JsonNull : ids;
  }
}
