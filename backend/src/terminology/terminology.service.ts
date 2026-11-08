// TerminologyService — domain glossary for the NL2SQL prompt. Implements the
// `system/terminology` API; the frontend views/system/professional/index.vue
// is the source of truth for the wire contract.
//
// Two concerns live side by side:
//   1. CRUD + Excel — the parity surface (page/upsert/remove/enable/export/
//      template/uploadExcel). Controller maps to snake_case via
//      terminology-snake-mapper. Parents hold pid=null; synonyms are
//      child rows with pid=parentId (so `other_words` is derived, not stored).
//   2. Recall + prompt template — the chat-pipeline helpers (recall +
//      getTerminologyTemplate). Called via DI (not HTTP; the @Get('recall') +
//      @Get('template') HTTP routes of the pre-parity controller were dead code
//      — the frontend never calls them). The HTTP
//      `@Get('template')` route is repurposed for the Excel template blob.
//
// Hybrid recall degrades to ILIKE-only when no embedding key is configured.
//
// Parity notes:
//   - recall maps synonym-child hits back to their parent term (pid walk-up).
//   - ds_list/adv_list filters are in-memory post-filters (JSON-array
//     containment is kept in JS for portability); fine for small datasets.
//   - importExcel writes failed rows to an error workbook servable through
//     POST /system/download-fail-info.
//   - upsert rejects duplicate words (term + synonyms) with an actionable
//     400; QueryPrism keeps a workspace-wide (oid, word) unique constraint.
//   - Excel headers/example rows are hardcoded Chinese (no backend i18n service,
//     §104 deviation).
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type Terminology } from '@prisma/client';
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
// P3-3: the ds/adv filter + name-map + cellText helpers were copy-pasted in
// terminology + custom-prompt (drift risk) — shared implementations.
import {
  applyDsAdvFilters,
  buildAdvancedAppNamesMap,
  buildAssistantNameToIdMap,
  buildDatasourceNameToIdMap,
  buildDatasourceNamesMap,
  cellText,
} from '../common/import-export/helpers';
import {
  toTerminologySnake,
  type TerminologySnake,
  type TerminologyRow,
} from './terminology-snake-mapper';
import { tr } from '../common/i18n/translate';

/** Vector collection name shared with VectorService. */
export const TERMINOLOGY_COLLECTION = 'terminology';

/** PUT /system/terminology body — snake_case (frontend sends these field
 *  names). Plain interface (no DTO class) → ValidationPipe passthrough (§101).
 *  `id` present → update; absent → create. `datasource_names` +
 *  `advanced_application_name` are accepted for parity but ignored on write
 *  (derived on read). */
export interface TerminologyInfo {
  id?: number;
  word: string;
  description?: string;
  other_words?: string[];
  specific_ds?: boolean;
  datasource_ids?: number[];
  datasource_names?: string[];
  enabled?: boolean;
  advanced_application?: number | null;
  advanced_application_name?: string | null;
}

/** GET /system/terminology/page/:n/:s response — the full pager shape.
 *  The frontend reads only `data` + `total_count`; the extra fields are
 *  harmless parity carried for faithfulness. */
export interface TerminologyPage {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: TerminologySnake[];
}

/** POST /system/terminology/uploadExcel response — the shape the el-upload
 *  `onSuccess(response)` reads as `response.data.*` (el-upload does its own XHR,
 *  so the global TransformInterceptor envelope wraps this; the Uploader reads
 *  `response.data.success_count` / `failed_count` / `error_excel_filename`). */
export interface TerminologyImportResult {
  success_count: number;
  failed_count: number;
  duplicate_count: number;
  original_count: number;
  error_excel_filename: string | null;
}

@Injectable()
export class TerminologyService {
  private readonly logger = new Logger(TerminologyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vector: VectorService,
    private readonly embedding: EmbeddingService,
    private readonly importError: ImportErrorFileService,
  ) {}

  // ──────────────────────────── CRUD (parity) ────────────────────────────

  /** Paginated terminology list. Returns the full pager shape
   *  `{current_page, page_size, total_count, total_pages, data}`. Parents only
   *  (pid IS NULL). `word` filter is ILIKE on parent word/description.
   *  `dsList`/`advList` are in-memory post-filters (JSON-array containment is
   *  kept in JS for portability). Filter semantics: ds match =
   *  specific_ds=false (applies to all datasources) OR (specific_ds=true AND
   *  datasource_ids hits one of dsList); adv match = advanced_application IN
   *  advList; ds AND adv AND-combined. */
  async page(
    currentPage: number,
    pageSize: number,
    word?: string,
    dsList?: number[],
    advList?: number[],
  ): Promise<TerminologyPage> {
    const oid = this.currentOid();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    const where: Prisma.TerminologyWhereInput = { oid, pid: null };
    if (word && word.trim()) {
      const kw = word.trim();
      where.OR = [
        { word: { contains: kw, mode: 'insensitive' } },
        { description: { contains: kw, mode: 'insensitive' } },
      ];
    }
    // Fetch all matching parents (post-filter pagination — see deviation note).
    const parents = await this.prisma.terminology.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const filtered = applyDsAdvFilters(parents, dsList, advList);
    const total_count = filtered.length;
    const total_pages = total_count > 0 ? Math.ceil(total_count / ps) : 0;
    const cpClamped = total_pages > 0 ? Math.min(cp, total_pages) : 1;
    const start = (cpClamped - 1) * ps;
    const pageRows = filtered.slice(start, start + ps);

    const otherWordsMap = await this.buildOtherWordsMap(pageRows);
    const datasourceNamesMap = await buildDatasourceNamesMap(
      this.prisma,
      pageRows,
      this.currentOid(),
    );
    const advancedAppNamesMap = await buildAdvancedAppNamesMap(
      this.prisma,
      pageRows,
    );
    return {
      current_page: cpClamped,
      page_size: ps,
      total_count,
      total_pages,
      data: pageRows.map((r) =>
        toTerminologySnake(
          r as TerminologyRow,
          otherWordsMap,
          datasourceNamesMap,
          advancedAppNamesMap,
        ),
      ),
    };
  }

  /** PUT /system/terminology — create (no id) or update (with id) the parent
   *  + reconcile synonym children (other_words → children with pid=parentId).
   *  Returns the parent row (the @SystemLog resources callback reads word+id).
   *  Embeds the parent word+description into the pgvector index when an embedding
   *  key is configured; children carry no embedding (display-only).
   *  `precomputedEmbedding` (P2-4) lets importExcel pass a batch-computed
   *  embedding instead of triggering one round-trip per row. */
  async upsert(
    info: TerminologyInfo,
    precomputedEmbedding?: number[] | null,
  ): Promise<Terminology> {
    const oid = this.currentOid();
    if (!info.word || !info.word.trim()) {
      throw new BadRequestException(tr('terminology.word_required'));
    }
    const word = info.word.trim();
    const description = info.description?.trim() || null;
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
          '术语引用的数据源不存在或不属于当前工作空间',
        );
      }
    }
    const enabled = info.enabled ?? true;
    // Store the stringified assistant id in the String? column; the mapper
    // coerces back to a number on read (§100 wire contract).
    const advancedApplication =
      info.advanced_application != null
        ? String(info.advanced_application)
        : null;

    // The embedding call is external (LLM/embedding provider) — compute it
    // BEFORE opening the transaction. Everything from the duplicate-scope
    // read to the child writes then runs in ONE interactive transaction:
    // a failure between the child deleteMany and createMany must roll the
    // parent update back instead of losing every synonym (half-applied
    // state).
    const embedding =
      precomputedEmbedding !== undefined
        ? precomputedEmbedding
        : await this.safeEmbed(this.embedText(word, description));

    const saved = await this.prisma.$transaction(async (tx) => {
      // Duplicate-scope guard: a term and its synonyms must be distinct, and
      // an existing row with any of those words is a conflict. The
      // workspace-wide (oid, word) uniqueness constraint makes this check
      // intentionally strict — it turns the opaque unique-constraint 500
      // into an actionable 400.
      const words = [
        word,
        ...(info.other_words ?? [])
          .map((w) => w.trim())
          .filter((w) => w.length > 0),
      ];
      if (new Set(words).size !== words.length) {
        throw new BadRequestException(tr('terminology.word_duplicates'));
      }
      const conflicts = await tx.terminology.findMany({
        where: {
          oid,
          word: { in: words },
          ...(info.id
            ? { NOT: { OR: [{ id: info.id }, { pid: info.id }] } }
            : {}),
        },
        select: { word: true },
        take: 1,
      });
      if (conflicts.length > 0) {
        throw new BadRequestException(
          tr('terminology.word_exists', { word: conflicts[0].word }),
        );
      }

      if (info.id) {
        // Verify ownership (throws NotFound if the id isn't in this
        // workspace) on the transaction client.
        const owned = await tx.terminology.findFirst({
          where: { id: info.id, oid },
          select: { id: true },
        });
        if (!owned)
          throw new NotFoundException(
            tr('terminology.term_not_found', { id: info.id }),
          );
        const updated = await tx.terminology.update({
          where: { id: info.id },
          data: {
            word,
            description,
            specificDs,
            datasourceIds: this.jsonIds(datasourceIds),
            enabled,
            advancedApplication,
            embedding: this.jsonEmbedding(embedding),
          },
        });
        // Reconcile children: delete old + insert new (delete WHERE pid=id
        // then re-insert).
        await tx.terminology.deleteMany({ where: { pid: info.id } });
        await this.createChildren(
          info.id,
          oid,
          info.other_words,
          enabled,
          specificDs,
          datasourceIds,
          tx,
        );
        return updated;
      }

      const parent = await tx.terminology.create({
        data: {
          oid,
          word,
          description,
          specificDs,
          datasourceIds: this.jsonIds(datasourceIds),
          enabled,
          advancedApplication,
          embedding: this.jsonEmbedding(embedding),
        },
      });
      await this.createChildren(
        parent.id,
        oid,
        info.other_words,
        enabled,
        specificDs,
        datasourceIds,
        tx,
      );
      return parent;
    });
    await this.syncVector(saved.id, embedding);
    return saved;
  }

  /** DELETE /system/terminology — batch delete parents + their children
   *  (WHERE oid AND (id IN ids OR pid IN ids), scoped to the caller's
   *  workspace per CWE-639). Best-effort removes each from the vector
   *  index. Returns the ids (for the @SystemLog resources callback). */
  async remove(ids: number[]): Promise<{ id: number }[]> {
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }
    const oid = this.currentOid();
    await this.prisma.terminology.deleteMany({
      where: { oid, OR: [{ id: { in: ids } }, { pid: { in: ids } }] },
    });
    if (this.vector.available) {
      for (const id of ids) {
        try {
          await this.vector.remove(TERMINOLOGY_COLLECTION, id);
        } catch (e) {
          this.logger.warn(
            `vector remove failed for terminology #${id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return ids.map((id) => ({ id }));
  }

  /** GET /system/terminology/:id/enable/:enabled — toggle enabled on the
   *  parent + all its children (WHERE id=id OR pid=id). */
  async setEnabled(
    id: number,
    enabled: boolean,
  ): Promise<{ id: number; enabled: boolean }> {
    await this.findOneOrFail(id);
    const oid = this.currentOid();
    await this.prisma.terminology.updateMany({
      where: { oid, OR: [{ id }, { pid: id }] },
      data: { enabled },
    });
    return { id, enabled };
  }

  // ─────────────────────────── Excel export/template ───────────────────────

  /** GET /system/terminology/export?word=&ds_list=&adv_list= — xlsx of the
   *  FILTERED parents (no pagination; honors the same word/ds_list/adv_list
   *  filters as page). 6 columns: word, other_words, description, datasource,
   *  all_data_sources, advanced_application_name. The controller streams the
   *  buffer via @Res() with the xlsx content-type + disposition (bypasses
   *  TransformInterceptor via headersSent). */
  async exportAll(
    word?: string,
    dsList?: number[],
    advList?: number[],
  ): Promise<Buffer> {
    const oid = this.currentOid();
    const where: Prisma.TerminologyWhereInput = { oid, pid: null };
    if (word && word.trim()) {
      const kw = word.trim();
      where.OR = [
        { word: { contains: kw, mode: 'insensitive' } },
        { description: { contains: kw, mode: 'insensitive' } },
      ];
    }
    const allParents = await this.prisma.terminology.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const parents = applyDsAdvFilters(allParents, dsList, advList);
    const otherWordsMap = await this.buildOtherWordsMap(parents);
    const datasourceNamesMap = await buildDatasourceNamesMap(
      this.prisma,
      parents,
      this.currentOid(),
    );
    const advancedAppNamesMap = await buildAdvancedAppNamesMap(
      this.prisma,
      parents,
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('terminology');
    ws.columns = [
      { header: tr('terminology.col_word'), key: 'word', width: 24 },
      {
        header: tr('terminology.col_other_words'),
        key: 'other_words',
        width: 24,
      },
      {
        header: tr('terminology.col_description'),
        key: 'description',
        width: 40,
      },
      {
        header: tr('terminology.col_datasource'),
        key: 'datasource',
        width: 24,
      },
      {
        header: tr('terminology.col_all_data_sources'),
        key: 'all_data_sources',
        width: 12,
      },
      {
        header: tr('terminology.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    for (const r of parents) {
      const snake = toTerminologySnake(
        r as TerminologyRow,
        otherWordsMap,
        datasourceNamesMap,
        advancedAppNamesMap,
      );
      ws.addRow({
        word: snake.word,
        other_words: snake.other_words.join(', '),
        description: snake.description ?? '',
        datasource: snake.specific_ds ? snake.datasource_names.join(', ') : '',
        all_data_sources: snake.specific_ds ? 'N' : 'Y',
        advanced_application_name: snake.advanced_application_name ?? '',
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** GET /system/terminology/template — xlsx with 2 example rows + the same 6
   *  column headers as the export. Headers/example strings are hardcoded
   *  Chinese (no backend i18n). */
  getTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('terminology');
    ws.columns = [
      { header: tr('terminology.col_word'), key: 'word', width: 24 },
      {
        header: tr('terminology.col_other_words'),
        key: 'other_words',
        width: 24,
      },
      {
        header: tr('terminology.col_description'),
        key: 'description',
        width: 40,
      },
      {
        header: tr('terminology.col_datasource'),
        key: 'datasource',
        width: 24,
      },
      {
        header: tr('terminology.col_all_data_sources'),
        key: 'all_data_sources',
        width: 12,
      },
      {
        header: tr('terminology.col_advanced_application'),
        key: 'advanced_application_name',
        width: 20,
      },
    ];
    ws.addRow({
      word: '收入',
      other_words: '营收, 营业收入',
      description: '企业在一定期间内经济利益的总流入',
      datasource: 'sales',
      all_data_sources: 'N',
      advanced_application_name: '',
    });
    ws.addRow({
      word: '成本',
      other_words: '',
      description: '企业在一定期间内经济利益的总流出',
      datasource: '',
      all_data_sources: 'Y',
      advanced_application_name: '',
    });
    return wb.xlsx.writeBuffer().then((buf) => Buffer.from(buf));
  }

  // ─────────────────────────── Excel import (uploadExcel) ─────────────────

  /** POST /system/terminology/uploadExcel — parse the uploaded xlsx, validate
   *  each row, create valid parents + children, collect failures. Returns the
   *  summary the el-upload `onSuccess` reads as `response.data.*`.
   *
   *  6 columns (1-indexed): word | other_words | description | datasource |
   *  all_data_sources | advanced_application_name. `datasource` is a comma-
   *  joined list of datasource NAMES (resolved to ids via a batch lookup);
   *  `all_data_sources` Y/yes/true → specific_ds=false. */
  async importExcel(buffer: Buffer): Promise<TerminologyImportResult> {
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
    const ws = wb.getWorksheet('terminology') ?? wb.worksheets[0];
    if (!ws) {
      return {
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      };
    }
    // Pre-build name→id maps for datasource + assistant resolution (avoids
    // N+1 per row).
    const datasourceNameToId = await buildDatasourceNameToIdMap(
      this.prisma,
      this.currentOid(),
    );
    const assistantNameToId = await buildAssistantNameToIdMap(this.prisma, oid);

    const records: TerminologyInfo[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return; // header
      const word = cellText(row.getCell(1).value).trim();
      if (!word) return; // skip blank rows; counted neither way
      const otherWordsRaw = cellText(row.getCell(2).value).trim();
      const description = cellText(row.getCell(3).value).trim();
      const datasourceNamesRaw = cellText(row.getCell(4).value).trim();
      const allDsRaw = cellText(row.getCell(5).value).trim().toLowerCase();
      const advancedAppName = cellText(row.getCell(6).value).trim();
      const specificDs = !(
        allDsRaw === 'y' ||
        allDsRaw === 'yes' ||
        allDsRaw === 'true'
      );
      const datasource_names = datasourceNamesRaw
        ? datasourceNamesRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      records.push({
        word,
        description: description || undefined,
        other_words: otherWordsRaw
          ? otherWordsRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        specific_ds: specificDs,
        datasource_names,
        enabled: true,
        advanced_application_name: advancedAppName || null,
      });
    });

    // P2-4: natural-key upsert — preload EVERY (word → id) for this file in
    // one query. The old loop always created (Excel rows carry no id), so
    // re-importing a file duplicated every row.
    const existingByWord = new Map<string, number>();
    if (records.length > 0) {
      const rows = await this.prisma.terminology.findMany({
        // Parents only: a synonym child sharing the imported word is a
        // duplicate-scope conflict, not an update target.
        where: { oid, pid: null, word: { in: records.map((r) => r.word) } },
        select: { id: true, word: true },
      });
      rows.forEach((r) => existingByWord.set(r.word, r.id));
    }
    // P2-4: ONE batched embedding round-trip for the whole file (the old
    // path did a synchronous embed call per row inside upsert()).
    const pres = await this.safeEmbedBatch(
      records.map((r) => this.embedText(r.word, r.description ?? null)),
    );

    let successCount = 0;
    let duplicateCount = 0;
    const failures: { info: TerminologyInfo; message: string }[] = [];
    for (const [i, info] of records.entries()) {
      try {
        // Resolve datasource_names → ids (only when specific_ds).
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
        const existingId = existingByWord.get(info.word);
        if (existingId != null) {
          info.id = existingId; // upsert takes its update path
          duplicateCount++;
        }
        await this.upsert(info, pres[i]);
        successCount++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ info, message });
        this.logger.warn(`terminology import row skipped: ${message}`);
      }
    }
    let errorFilename: string | null = null;
    if (failures.length > 0) {
      errorFilename = await this.importError.write({
        prefix: 'terminology',
        headers: [
          '术语名称',
          '同义词',
          '术语描述',
          '生效数据源',
          '全部数据源',
          '高级应用',
        ],
        rows: failures.map(({ info }) => [
          info.word,
          (info.other_words ?? []).join(', '),
          info.description ?? '',
          info.specific_ds ? (info.datasource_names ?? []).join(', ') : '',
          info.specific_ds ? 'N' : 'Y',
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

  // ─────────────────────── recall + prompt template (chat) ───────────────
  // Unchanged from pre-parity — the chat pipeline calls these via DI (not
  // HTTP). Hybrid recall: cosine (pgvector) merged with ILIKE; degrades to
  // ILIKE-only when no embedding key is configured.

  /** Hybrid recall: cosine (if available) merged with ILIKE, scoped by
   *  workspace + enabled + datasource specificity. `cfg` is the task-start
   *  embedding snapshot (9e6070e8): enabled=false keeps the ILIKE literal
   *  branch only, cosine hits must beat terminologySimilarity (strictly),
   *  and the candidate count defaults to terminologyTopCount. */
  async recall(
    query: string,
    datasourceId?: number,
    topK?: number,
    cfg?: EmbeddingConfig,
  ): Promise<Terminology[]> {
    const oid = this.currentOid();
    const q = query.trim();
    if (!q) return [];
    const config = cfg ?? (await resolveEmbeddingConfig(this.prisma));
    const k = Math.max(1, Math.floor(topK ?? config.terminologyTopCount));

    // 1. ILIKE — cheap exact-keyword matches.
    const likeMatches = await this.prisma.terminology.findMany({
      where: {
        oid,
        enabled: true,
        OR: [
          { word: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: k * 4,
    });

    // 2. Cosine — semantic matches from the pgvector index.
    const cosineHits: Terminology[] = [];
    if (config.enabled && this.embedding.available && this.vector.available) {
      try {
        const vec = await this.embedding.embed(q);
        const hits = (
          await this.vector.search(TERMINOLOGY_COLLECTION, vec, k * 2)
        )
          // strictly above the similarity threshold (upstream semantics)
          .filter((h) => 1 - h.distance > config.terminologySimilarity);
        const ids = hits.map((h) => Number(h.id));
        if (ids.length > 0) {
          const rows = await this.prisma.terminology.findMany({
            where: { oid, enabled: true, id: { in: ids } },
          });
          // Preserve cosine distance order (most similar first).
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const h of hits) {
            const term = byId.get(Number(h.id));
            if (term) cosineHits.push(term);
          }
        }
      } catch (e) {
        this.logger.warn(
          `cosine terminology recall failed, ILIKE-only: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 3. Merge + dedupe (cosine first, then ILIKE-only), mapping synonym child
    //    hits back to their parent term (pid walk-up).
    const ordered = await this.toParentTerms(oid, [
      ...cosineHits,
      ...likeMatches,
    ]);

    // 4. Datasource specificity filter (Prisma can't query JSON-array contains
    //    portably, so post-filter).
    const scoped = ordered.filter((t) =>
      this.matchesDatasource(t, datasourceId),
    );
    return scoped.slice(0, k);
  }

  /** Replace child/synonym rows with their parent term, dedupe, preserve order. */
  private async toParentTerms(
    oid: number,
    terms: Terminology[],
  ): Promise<Terminology[]> {
    const parentIds = [
      ...new Set(
        terms.filter((t) => t.pid != null).map((t) => t.pid as number),
      ),
    ];
    const parents =
      parentIds.length > 0
        ? await this.prisma.terminology.findMany({
            where: { id: { in: parentIds }, oid, enabled: true },
          })
        : [];
    const parentById = new Map(parents.map((p) => [p.id, p]));
    const seen = new Set<number>();
    const out: Terminology[] = [];
    for (const term of terms) {
      const resolved = term.pid == null ? term : parentById.get(term.pid);
      if (!resolved || seen.has(resolved.id)) continue;
      seen.add(resolved.id);
      out.push(resolved);
    }
    return out;
  }

  /** Render matched terms into the XML block injected into the SQL prompt.
   *  Returns '' when nothing matched (caller omits the section). */
  async getTerminologyTemplate(
    query: string,
    datasourceId?: number,
    topK?: number,
    cfg?: EmbeddingConfig,
  ): Promise<string> {
    const terms = await this.recall(query, datasourceId, topK, cfg);
    if (terms.length === 0) return '';
    const rows = terms
      .map((t) => {
        const parts = [`word="${escAttr(t.word)}"`];
        if (t.description)
          parts.push(`description="${escAttr(t.description)}"`);
        if (t.advancedApplication)
          parts.push(`advancedApplication="${escAttr(t.advancedApplication)}"`);
        return `  <terminology ${parts.join(' ')} />`;
      })
      .join('\n');
    return `<terminologies>\n${rows}\n</terminologies>`;
  }

  /** 3fd6fa86/e685a749 (expand_with_terminology port): expand a keyword list
   *  with the workspace's enabled synonym groups — a hit on EITHER the parent
   *  word or any child word folds in the whole group (parent + all synonyms).
   *  Caps: 500 terms scanned, 10 keywords out. Returns the ORIGINAL string on
   *  any error (recall then just runs on the unexpanded keywords). */
  async expandWithTerminology(keywords: string, oid: number): Promise<string> {
    const kwList = keywords
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (kwList.length === 0 || oid == null) return keywords;
    try {
      const terms = await this.prisma.terminology.findMany({
        where: { oid, enabled: true },
        take: 500,
        select: { id: true, pid: true, word: true },
      });
      if (terms.length === 0) return keywords;

      const parentWords = new Map<number, string>(); // parent id → word
      const childrenByParent = new Map<number, string[]>();
      const wordToParentIds = new Map<string, Set<number>>();
      const index = (word: string, parentId: number) => {
        const w = (word ?? '').trim().toLowerCase();
        if (!w) return;
        const ids = wordToParentIds.get(w) ?? new Set<number>();
        ids.add(parentId);
        wordToParentIds.set(w, ids);
      };
      for (const t of terms) {
        if (t.pid == null || t.pid === 0) {
          parentWords.set(t.id, (t.word ?? '').trim());
          index(t.word, t.id);
        } else {
          const arr = childrenByParent.get(t.pid) ?? [];
          arr.push((t.word ?? '').trim());
          childrenByParent.set(t.pid, arr);
          index(t.word, t.pid);
        }
      }

      const expanded = [...kwList];
      const seen = new Set(kwList.map((k) => k.toLowerCase()));
      const MAX_KEYWORDS = 10;
      for (const kw of kwList) {
        if (expanded.length >= MAX_KEYWORDS) break;
        for (const pid of wordToParentIds.get(kw.toLowerCase()) ?? []) {
          if (expanded.length >= MAX_KEYWORDS) break;
          const parentWord = parentWords.get(pid);
          if (parentWord && !seen.has(parentWord.toLowerCase())) {
            expanded.push(parentWord);
            seen.add(parentWord.toLowerCase());
          }
          for (const childWord of childrenByParent.get(pid) ?? []) {
            if (expanded.length >= MAX_KEYWORDS) break;
            if (childWord && !seen.has(childWord.toLowerCase())) {
              expanded.push(childWord);
              seen.add(childWord.toLowerCase());
            }
          }
        }
      }
      return expanded.join(',');
    } catch (e) {
      this.logger.warn(
        `terminology keyword expansion failed, using raw keywords: ${e instanceof Error ? e.message : String(e)}`,
      );
      return keywords;
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────────

  /** Batch-build a parentId → [child.word] map for the page (avoids N+1 per
   *  row when resolving `other_words`). */
  private async buildOtherWordsMap(
    parents: { id: number }[],
  ): Promise<Map<number, string[]>> {
    const parentIds = parents.map((p) => p.id);
    if (parentIds.length === 0) return new Map();
    const children = await this.prisma.terminology.findMany({
      where: { pid: { in: parentIds } },
      select: { pid: true, word: true },
    });
    const map = new Map<number, string[]>();
    for (const c of children) {
      if (c.pid == null) continue;
      const arr = map.get(c.pid) ?? [];
      arr.push(c.word);
      map.set(c.pid, arr);
    }
    return map;
  }

  /** Insert synonym children for a parent (other_words → rows with pid).
   *  Runs on the caller's client — the transaction client inside upsert. */
  private async createChildren(
    parentId: number,
    oid: number,
    otherWords: string[] | undefined,
    enabled: boolean,
    specificDs: boolean,
    datasourceIds: number[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const words = (otherWords ?? [])
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    if (words.length === 0) return;
    await client.terminology.createMany({
      data: words.map((w) => ({
        pid: parentId,
        oid,
        word: w,
        specificDs,
        datasourceIds: this.jsonIds(datasourceIds),
        enabled,
      })),
    });
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private async findOneOrFail(id: number): Promise<Terminology> {
    const oid = this.currentOid();
    const row = await this.prisma.terminology.findFirst({ where: { id, oid } });
    if (!row)
      throw new NotFoundException(tr('terminology.term_not_found', { id }));
    return row;
  }

  private embedText(word: string, description?: string | null): string {
    return embedRowText(word, description);
  }

  /** Embed if available; never throw — a failure logs and returns null so
   *  recall degrades to ILIKE-only instead of breaking. */
  private async safeEmbed(text: string): Promise<number[] | null> {
    if (!text.trim() || !this.embedding.available) return null;
    try {
      return await this.embedding.embed(text);
    } catch (e) {
      this.logger.warn(
        `terminology embedding failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** P2-4: batch variant of safeEmbed for imports — ONE embedding round-trip
   *  for the whole file instead of one per row. Never throws; failures degrade
   *  every row to a null embedding (ILIKE-only recall), per safeEmbed. */
  private async safeEmbedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    if (!texts.some((t) => t.trim()) || !this.embedding.available) {
      return texts.map(() => null);
    }
    try {
      return await this.embedding.embedBatch(texts);
    } catch (e) {
      this.logger.warn(
        `terminology batch embedding failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return texts.map(() => null);
    }
  }

  /** Keep the pgvector index in sync with the row. Vector failures never break
   *  CRUD — they log and degrade recall to ILIKE-only. */
  private async syncVector(
    id: number,
    embedding: number[] | null,
  ): Promise<void> {
    if (!this.vector.available) return;
    try {
      if (embedding && embedding.length > 0) {
        await this.vector.upsert(TERMINOLOGY_COLLECTION, id, embedding);
      } else {
        await this.vector.remove(TERMINOLOGY_COLLECTION, id);
      }
    } catch (e) {
      this.logger.warn(
        `vector sync failed for terminology #${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Prisma JSON columns can't store a JS `null` directly — map to the
   *  JsonNull sentinel so a missing embedding persists as SQL NULL. */
  private jsonEmbedding(
    embedding: number[] | null,
  ): Prisma.NullableJsonNullValueInput | number[] {
    return embedding === null ? Prisma.JsonNull : embedding;
  }

  /** Same JsonNull-sentinel pattern for the `datasourceIds` column: empty →
   *  SQL NULL (Prisma.JsonNull), non-empty → the number[] (InputJsonValue).
   *  Prisma's create/update/createMany inputs reject a plain `null` or a
   *  loose `JsonValue` cast, so the helper returns the exact union type. */
  private jsonIds(ids: number[]): Prisma.NullableJsonNullValueInput | number[] {
    return ids.length === 0 ? Prisma.JsonNull : ids;
  }

  private matchesDatasource(t: Terminology, datasourceId?: number): boolean {
    if (!t.specificDs) return true; // global term applies everywhere
    if (datasourceId == null) return false; // specific but no context
    const ids = Array.isArray(t.datasourceIds)
      ? (t.datasourceIds as number[])
      : [];
    return ids.includes(datasourceId);
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
