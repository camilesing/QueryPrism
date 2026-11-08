// DataTrainingService — SQL sample (Q&A) knowledge base for the NL2SQL prompt.
//
// recall() + getDataTrainingTemplate() are LIVE chat-DI methods (ai-question
// .service injects DataTrainingService + calls getDataTrainingTemplate());
// they are kept verbatim — the HTTP @Get('recall')/@Get('template') routes
// were dead code (dropped in the controller rewrite).
//
// The CRUD routes (page/upsert/remove/setEnabled/exportAll/getTemplate/
// importExcel) are the HTTP contract (snake_case wire via
// data-training-snake-mapper). Embeddings: re-embed on question/description
// change; sync the vector index; degrade to null when no embedding key. Excel
// import/export via exceljs for bulk curation.
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type DataTraining } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { VectorService } from '../vector/vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { embedRowText } from '../embedding/embed-text';
import { RequestContext } from '../common/context/request-context';
import { ImportErrorFileService } from '../common/import-export/import-error-file.service';
import {
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from '../common/config/embedding-config';
import {
  toDataTrainingSnake,
  type DataTrainingRow,
  type DataTrainingSnake,
} from './data-training-snake-mapper';
import { tr } from '../common/i18n/translate';

/** Vector collection name shared with VectorService. */
export const DATA_TRAINING_COLLECTION = 'data_training';

/** snake_case PUT body (§101 plain interface → ValidationPipe passthrough). id
 *  in → update; absent → create. datasource_name/advanced_application_name are
 *  display-only (resolved server-side for the response); the form sends the id
 *  fields (datasource/advanced_application). */
export interface DataTrainingInfo {
  id?: number;
  datasource?: number | null;
  datasource_name?: string | null;
  question?: string;
  description?: string;
  enabled?: boolean;
  advanced_application?: number | null;
  advanced_application_name?: string | null;
}

export interface DataTrainingPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: DataTrainingSnake[];
}

export interface DataTrainingImportResult {
  success_count: number;
  failed_count: number;
  duplicate_count: number;
  original_count: number;
  error_excel_filename: string | null;
}

@Injectable()
export class DataTrainingService {
  private readonly logger = new Logger(DataTrainingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vector: VectorService,
    private readonly embedding: EmbeddingService,
    private readonly importError: ImportErrorFileService,
  ) {}

  // --- CRUD (snake_case wire) ---------------------------------------------

  /** GET /system/data-training/page/:current_page/:page_size?question=&ds_list=&adv_list=
   *  Single keyword `question` filter (NOT repeated, NOT `__`-joined). Matches
   *  by ILIKE on question OR description (case-insensitive). `dsList`/
   *  `advList` are the REPEATED-query-param id lists: `datasource IN dsList`
   *  AND `advancedApplication IN advList`, both AND-combined with the
   *  keyword. advancedApplication is stored as String → ids stringified. */
  async page(
    currentPage: number,
    pageSize: number,
    question?: string,
    dsList?: number[],
    advList?: number[],
  ): Promise<DataTrainingPage> {
    const oid = this.currentOid();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = pageSize > 0 ? Math.floor(pageSize) : 10;
    const where = this.buildListWhere(oid, question, dsList, advList);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.dataTraining.count({ where }),
      this.prisma.dataTraining.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (cp - 1) * ps,
        take: ps,
      }),
    ]);
    const datasourceNameMap = await this.buildDatasourceNameMap(rows);
    const advancedAppNamesMap = await this.buildAdvancedAppNamesMap(rows);
    const data = rows.map((r) =>
      toDataTrainingSnake(
        this.toRow(r),
        datasourceNameMap,
        advancedAppNamesMap,
      ),
    );
    const totalPages = ps > 0 ? Math.ceil(total / ps) : 0;
    return {
      current_page: cp,
      page_size: ps,
      total_count: total,
      total_pages: totalPages,
      data,
    };
  }

  /** PUT /system/data-training (body DataTrainingInfo). id in → update,
   *  absent → create. Validates question non-empty. advanced_application is
   *  stored as String? and coerced back to a number on read (same as
   *  terminology). */
  async upsert(info: DataTrainingInfo): Promise<DataTraining> {
    const oid = this.currentOid();
    const question = info.question?.trim() ?? '';
    if (!question) {
      throw new BadRequestException(tr('data-training.question_required'));
    }
    const description = info.description?.trim() || null;
    const datasource =
      info.datasource === undefined ? null : (info.datasource ?? null);
    if (datasource != null) {
      const found = await this.prisma.datasource.count({
        where: { id: datasource, oid },
      });
      if (!found) {
        throw new BadRequestException(tr('data-training.ds_ref_invalid'));
      }
    }
    const advancedApplication =
      info.advanced_application != null
        ? String(info.advanced_application)
        : null;
    const enabled = info.enabled ?? true;

    if (info.id) {
      await this.findOneOrFail(info.id);
      const embedding = await this.safeEmbed(
        this.embedText(question, description),
      );
      const row = await this.prisma.dataTraining.update({
        where: { id: info.id },
        data: {
          question,
          description,
          datasource,
          enabled,
          advancedApplication,
          embedding: this.jsonEmbedding(embedding),
        },
      });
      await this.syncVector(row.id, embedding);
      return row;
    }
    const embedding = await this.safeEmbed(
      this.embedText(question, description),
    );
    const row = await this.prisma.dataTraining.create({
      data: {
        oid,
        question,
        description,
        datasource,
        enabled,
        advancedApplication,
        embedding: this.jsonEmbedding(embedding),
      },
    });
    await this.syncVector(row.id, embedding);
    return row;
  }

  /** DELETE /system/data-training (body bare array [ids]). No pid/children
   *  here (unlike terminology) — flat delete by id IN. [] is a no-op (§100
   *  guard against Prisma P2021 on empty IN). Best-effort vector.remove.
   *  Returns `[{id}]` so the @SystemLog DELETE callback can extract the ids
   *  for the audit log (mirrors terminology's remove return shape). */
  async remove(ids: number[]): Promise<{ id: number }[]> {
    const idNums = (Array.isArray(ids) ? ids : []).map((id) =>
      typeof id === 'string' ? Number(id) : id,
    );
    if (idNums.length === 0) return [];
    await this.prisma.dataTraining.deleteMany({
      where: { oid: this.currentOid(), id: { in: idNums } },
    });
    if (this.vector.available) {
      for (const id of idNums) {
        try {
          await this.vector.remove(DATA_TRAINING_COLLECTION, id);
        } catch (e) {
          this.logger.warn(
            `vector remove failed for data-training #${id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return idNums.map((id) => ({ id }));
  }

  /** GET /system/data-training/:id/enable/:enabled (path string). */
  async setEnabled(id: number, enabled: boolean): Promise<DataTraining> {
    await this.findOneOrFail(id);
    return this.prisma.dataTraining.update({
      where: { id },
      data: { enabled },
    });
  }

  /** GET /system/data-training/export?question=&ds_list=&adv_list= → xlsx blob
   *  of the FILTERED list (honors the same ds_list/adv_list/keyword filters as
   *  page). Exports 4 columns (no enabled): question / description /
   *  datasource_name / advanced_application_name. Names resolved via batch maps
   *  (no N+1). */
  async exportAll(
    question?: string,
    dsList?: number[],
    advList?: number[],
  ): Promise<Buffer> {
    const oid = this.currentOid();
    const where = this.buildListWhere(oid, question, dsList, advList);
    const rows = await this.prisma.dataTraining.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const datasourceNameMap = await this.buildDatasourceNameMap(rows);
    const advancedAppNamesMap = await this.buildAdvancedAppNamesMap(rows);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data_training');
    ws.columns = [
      { header: tr('data-training.col_question'), key: 'question', width: 40 },
      {
        header: tr('data-training.col_sample_sql'),
        key: 'description',
        width: 40,
      },
      {
        header: tr('common.col_effective_ds'),
        key: 'datasource_name',
        width: 20,
      },
      {
        header: tr('common.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    for (const r of rows) {
      const snake = toDataTrainingSnake(
        this.toRow(r),
        datasourceNameMap,
        advancedAppNamesMap,
      );
      ws.addRow({
        question: r.question,
        description: r.description ?? '',
        datasource_name: snake.datasource_name ?? '',
        advanced_application_name: snake.advanced_application_name ?? '',
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** GET /system/data-training/template → xlsx blob (1 sample row with
   *  placeholder values). */
  async getTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data_training');
    ws.columns = [
      { header: tr('data-training.col_question'), key: 'question', width: 40 },
      {
        header: tr('data-training.col_sample_sql'),
        key: 'description',
        width: 40,
      },
      {
        header: tr('common.col_effective_ds'),
        key: 'datasource_name',
        width: 20,
      },
      {
        header: tr('common.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    ws.addRow({
      question: '查询TEST表内所有ID',
      description: 'SELECT id FROM TEST',
      datasource_name: '生效数据源1',
      advanced_application_name: '生效高级应用名称',
    });
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** POST /system/data-training/uploadExcel (multipart `file`). Parses 4 cols,
   *  resolves datasource_name→id + advanced_application_name→id, upserts each
   *  (create-branch). Failed rows are written to `error_excel_filename`, which
   *  the Uploader downloads through POST /system/download-fail-info. */
  async importExcel(buffer: Buffer): Promise<DataTrainingImportResult> {
    const oid = this.currentOid();
    const wb = new ExcelJS.Workbook();
    type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
    await wb.xlsx.load(buffer as unknown as LoadParam);
    const ws = wb.getWorksheet('data_training') ?? wb.worksheets[0];
    if (!ws) {
      return {
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      };
    }
    const datasourceNameToId = await this.buildDatasourceNameToIdMap();
    const assistantNameToId = await this.buildAssistantNameToIdMap(oid);
    const records: DataTrainingInfo[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return; // header
      const question = cellText(row.getCell(1).value).trim();
      if (!question) return; // skip blank rows
      const description = cellText(row.getCell(2).value).trim();
      const dsName = cellText(row.getCell(3).value).trim();
      const advName = cellText(row.getCell(4).value).trim();
      records.push({
        question,
        description: description || undefined,
        datasource: dsName ? (datasourceNameToId.get(dsName) ?? null) : null,
        datasource_name: dsName || null,
        advanced_application: advName
          ? (assistantNameToId.get(advName) ?? null)
          : null,
        advanced_application_name: advName || null,
      });
    });
    // Re-importing the same file updates instead of duplicating (natural key:
    // workspace + question), mirroring terminology/custom-prompt.
    const existingByQuestion = new Map<string, number>();
    if (records.length > 0) {
      const rows =
        (await this.prisma.dataTraining.findMany({
          where: {
            oid,
            question: { in: records.map((r) => r.question ?? '') },
          },
          select: { id: true, question: true },
        })) ?? [];
      rows.forEach((row) => existingByQuestion.set(row.question, row.id));
    }

    let successCount = 0;
    let duplicateCount = 0;
    const failures: { info: DataTrainingInfo; message: string }[] = [];
    for (const r of records) {
      try {
        const existingId = existingByQuestion.get(r.question ?? '');
        if (existingId != null) {
          r.id = existingId;
          duplicateCount++;
        }
        await this.upsert(r);
        successCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ info: r, message });
        this.logger.warn(`import row skipped: ${message}`);
      }
    }
    let errorFilename: string | null = null;
    if (failures.length > 0) {
      errorFilename = await this.importError.write({
        prefix: 'data-training',
        headers: ['问题', '样例SQL', '数据源', '高级应用'],
        rows: failures.map(({ info }) => [
          info.question ?? '',
          info.description ?? '',
          info.datasource_name ?? '',
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

  // --- recall + prompt template (chat DI, NON-HTTP) ----------------------
  // Kept verbatim — ai-question.service injects this service + calls
  // getDataTrainingTemplate(). These are not exposed as HTTP routes (the old
  // @Get('recall')/@Get('template') were dead code, dropped in the rewrite).

  /** Hybrid recall scoped by workspace + datasource (global OR specific).
   *  `cfg` is the task-start embedding snapshot (9e6070e8): enabled=false
   *  keeps the literal branch only, cosine hits must beat
   *  dataTrainingSimilarity (strictly), count defaults to
   *  dataTrainingTopCount. */
  async recall(
    query: string,
    datasourceId?: number,
    topK?: number,
    cfg?: EmbeddingConfig,
  ): Promise<DataTraining[]> {
    const oid = this.currentOid();
    const q = query.trim();
    if (!q) return [];
    const config = cfg ?? (await resolveEmbeddingConfig(this.prisma));
    const k = Math.max(1, Math.floor(topK ?? config.dataTrainingTopCount));

    const dsWhere = this.datasourceScope(datasourceId);

    // 1. ILIKE — exact keyword matches. The datasource scope (an OR itself)
    //    must be AND-nested with the keyword OR; spreading would let the
    //    keyword OR overwrite the scope OR.
    const likeMatches = await this.prisma.dataTraining.findMany({
      where: {
        oid,
        enabled: true,
        AND: [
          dsWhere,
          {
            OR: [
              { question: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: k * 4,
    });

    // 2. Cosine — semantic matches from the pgvector index.
    const cosineHits: DataTraining[] = [];
    if (config.enabled && this.embedding.available && this.vector.available) {
      try {
        const vec = await this.embedding.embed(q);
        const hits = (
          await this.vector.search(DATA_TRAINING_COLLECTION, vec, k * 2)
        )
          // strictly above the similarity threshold (upstream semantics)
          .filter((h) => 1 - h.distance > config.dataTrainingSimilarity);
        const ids = hits.map((h) => Number(h.id));
        if (ids.length > 0) {
          const rows = await this.prisma.dataTraining.findMany({
            where: { oid, enabled: true, id: { in: ids }, ...dsWhere },
          });
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const h of hits) {
            const row = byId.get(Number(h.id));
            if (row) cosineHits.push(row);
          }
        }
      } catch (e) {
        this.logger.warn(
          `cosine data-training recall failed, ILIKE-only: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 3. Merge + dedupe (cosine first, then ILIKE-only).
    const seen = new Set<number>();
    const ordered: DataTraining[] = [];
    for (const row of cosineHits) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        ordered.push(row);
      }
    }
    for (const row of likeMatches) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        ordered.push(row);
      }
    }
    return ordered.slice(0, k);
  }

  /** Render matched samples into the XML block injected into the SQL prompt. */
  async getDataTrainingTemplate(
    query: string,
    datasourceId?: number,
    topK?: number,
    cfg?: EmbeddingConfig,
  ): Promise<string> {
    const rows = await this.recall(query, datasourceId, topK, cfg);
    if (rows.length === 0) return '';
    const items = rows
      .map((r) => {
        const parts = [`question="${escAttr(r.question)}"`];
        if (r.description)
          parts.push(`description="${escAttr(r.description)}"`);
        return `  <data_training ${parts.join(' ')} />`;
      })
      .join('\n');
    return `<data_training_examples>\n${items}\n</data_training_examples>`;
  }

  // --- helpers ------------------------------------------------------------

  /** Shared where-clause for page + export: keyword OR (question/description
   *  contains) AND datasource IN dsList AND advancedApplication IN advList.
   *  advancedApplication is a String? column → the adv ids are stringified
   *  for the IN list. All conditions AND-combined. */
  private buildListWhere(
    oid: number,
    question?: string,
    dsList?: number[],
    advList?: number[],
  ): Prisma.DataTrainingWhereInput {
    const where: Prisma.DataTrainingWhereInput = { oid };
    const q = question?.trim();
    if (q) {
      where.OR = [
        { question: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (dsList && dsList.length > 0) {
      where.datasource = { in: dsList };
    }
    if (advList && advList.length > 0) {
      where.advancedApplication = { in: advList.map(String) };
    }
    return where;
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private async findOneOrFail(id: number): Promise<DataTraining> {
    const oid = this.currentOid();
    const row = await this.prisma.dataTraining.findFirst({
      where: { id, oid },
    });
    if (!row)
      throw new NotFoundException(tr('data-training.sample_not_found', { id }));
    return row;
  }

  /** Narrow a Prisma row to the mapper's structural input. */
  private toRow(r: DataTraining): DataTrainingRow {
    return {
      id: r.id,
      oid: r.oid,
      datasource: r.datasource,
      question: r.question,
      description: r.description,
      enabled: r.enabled,
      advancedApplication: r.advancedApplication,
      createdAt: r.createdAt,
    };
  }

  /** Build Map<datasourceId, name> for the page rows' single datasource ids
   *  (data-training has a single Int? datasource, not an array like
   *  terminology). */
  private async buildDatasourceNameMap(
    rows: { datasource: number | null }[],
  ): Promise<Map<number, string>> {
    const ids = new Set<number>();
    for (const r of rows) {
      if (r.datasource != null) ids.add(r.datasource);
    }
    if (ids.size === 0) return new Map();
    const found = await this.prisma.datasource.findMany({
      where: { id: { in: Array.from(ids) }, oid: this.currentOid() },
      select: { id: true, name: true },
    });
    return new Map(found.map((d) => [d.id, d.name]));
  }

  /** Build Map<assistantId, name> for the page rows' advancedApplication ids
   *  (String? column → Number()-coerced). Mirrors terminology's helper;
   *  assistants are matched by id only (the Assistant.type enum is 0/2/4 —
   *  there is no dedicated advanced-application type). */
  private async buildAdvancedAppNamesMap(
    rows: { advancedApplication: string | null }[],
  ): Promise<Map<number, string>> {
    const ids = new Set<number>();
    for (const r of rows) {
      if (r.advancedApplication != null && r.advancedApplication !== '') {
        const n = Number(r.advancedApplication);
        if (!Number.isNaN(n)) ids.add(n);
      }
    }
    if (ids.size === 0) return new Map();
    const found = await this.prisma.assistant.findMany({
      where: { id: { in: Array.from(ids) } },
      select: { id: true, name: true },
    });
    return new Map(found.map((a) => [a.id, a.name]));
  }

  /** Build Map<datasourceName, id> for import resolution (name→id). Datasource
   *  is global (no oid filter, same as terminology's helper). */
  private async buildDatasourceNameToIdMap(): Promise<Map<string, number>> {
    const found = await this.prisma.datasource.findMany({
      where: { oid: this.currentOid() },
      select: { id: true, name: true },
    });
    return new Map(found.map((d) => [d.name, d.id]));
  }

  /** Build Map<assistantName, id> for import resolution (name→id),
   *  workspace-scoped (Assistant has oid). */
  private async buildAssistantNameToIdMap(
    oid: number,
  ): Promise<Map<string, number>> {
    const found = await this.prisma.assistant.findMany({
      where: { oid },
      select: { id: true, name: true },
    });
    return new Map(found.map((a) => [a.name, a.id]));
  }

  /** Scope where-clause: a sample applies if global (datasource null) OR
   *  matching the active Datasource. With no datasourceId, global only. */
  private datasourceScope(
    datasourceId?: number,
  ): Prisma.DataTrainingWhereInput {
    if (datasourceId === undefined) return { datasource: null };
    return { OR: [{ datasource: datasourceId }, { datasource: null }] };
  }

  private embedText(question: string, description?: string | null): string {
    return embedRowText(question, description);
  }

  private async safeEmbed(text: string): Promise<number[] | null> {
    if (!text.trim() || !this.embedding.available) return null;
    try {
      return await this.embedding.embed(text);
    } catch (e) {
      this.logger.warn(
        `data-training embedding failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private async syncVector(
    id: number,
    embedding: number[] | null,
  ): Promise<void> {
    if (!this.vector.available) return;
    try {
      if (embedding && embedding.length > 0) {
        await this.vector.upsert(DATA_TRAINING_COLLECTION, id, embedding);
      } else {
        await this.vector.remove(DATA_TRAINING_COLLECTION, id);
      }
    } catch (e) {
      this.logger.warn(
        `vector sync failed for data-training #${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private jsonEmbedding(
    embedding: number[] | null,
  ): Prisma.NullableJsonNullValueInput | number[] {
    return embedding === null ? Prisma.JsonNull : embedding;
  }
}

/** Escape a value for use as an XML attribute. */
function escAttr(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Coerce an exceljs cell value to a string without tripping on rich-text /
 *  formula objects (which would stringify to '[object Object]'). Primitives
 *  flow through; objects are unpacked defensively. */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((r) => (r as { text?: unknown }).text ?? '')
        .filter((t): t is string => typeof t === 'string')
        .join('');
    }
    if ('result' in obj) return cellText(obj.result);
    if (typeof obj.text === 'string') return obj.text;
    return '';
  }
  return '';
}
