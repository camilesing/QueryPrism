import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ADMIN_UID } from '../auth/admin.guard';
import { DbConnectorFactory } from './db-connector/db-connector.factory';
import { ExcelStoreService } from './excel-store.service';
import type {
  ConnectionConfig,
  DbConnector,
  FieldMeta,
} from './db-connector/db-connector.interface';
import {
  buildMSchema,
  diffRelationEdges,
  normalizeTableRelation,
  relationIdNamesOf,
  type MSchemaSemantics,
} from './m-schema.builder';
import { calcKeywordScore, rankTables } from './table-recall';
import {
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from '../common/config/embedding-config';
import { appendLimit } from './db-connector/limit-clause';
import { effectiveSqlHash } from '../quota/quota-policy';
import { QueryCacheService } from '../quota/query-cache.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { embedRowText } from '../embedding/embed-text';
import { VectorService } from '../vector/vector.service';
import {
  RequestContext,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { tr } from '../common/i18n/translate';

/** Table row with the fields include the keyword scorer needs. */
type TableWithFields = Prisma.TableGetPayload<{
  include: {
    fields: {
      select: { fieldName: true; fieldComment: true; customComment: true };
    };
  };
}>;

/** Loose mutate-input shape. `configuration` is `string | object` so BOTH the
 *  new contract (frontend pre-encrypts → string stored verbatim) and the
 *  legacy Phase 2 controller (object → encrypted here) typecheck. The
 *  service duck-types at runtime via `normalizeConfiguration`. */
type DatasourceMutateInput = {
  name: string;
  description?: string | null;
  type: string;
  configuration?: string | object | null;
  status?: string;
  tables?: { table_name: string; table_comment?: string | null }[];
};

/** Snake_case body for editTable/editField — only `checked` + `custom_comment`
 *  are persisted. */
type TableEditBody = {
  id: number;
  custom_comment?: string | null;
  checked?: boolean;
};
type FieldEditBody = {
  id: number;
  custom_comment?: string | null;
  checked?: boolean;
};

@Injectable()
export class DatasourceService {
  private readonly logger = new Logger(DatasourceService.name);

  constructor(
    private prisma: PrismaService,
    private readonly connectorFactory: DbConnectorFactory,
    private readonly config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly vector: VectorService,
    private readonly excelStore: ExcelStoreService,
    private readonly queryCache: QueryCacheService,
  ) {}

  async create(dto: DatasourceMutateInput) {
    const configuration = this.normalizeConfiguration(dto.configuration);
    const row = await this.prisma.datasource.create({
      data: {
        oid: this.currentOid(),
        name: dto.name,
        description: dto.description ?? null,
        type: dto.type,
        configuration,
      },
    });
    // Fire-and-forget: datasource embedding feeds the "select_datasource"
    // LLM step. Never block the create response on it.
    void this.embedDatasource(row.id, row.name, row.description).catch((e) =>
      this.logger.warn(
        `datasource #${row.id} embed failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    // The create+choose flow sends `tables`; the legacy Phase 2 controller
    // never does, so this is a no-op for it.
    if (dto.tables && dto.tables.length > 0) {
      await this.syncTable(row.id, dto.tables);
    }
    return row;
  }

  /** Normalize a configuration value for storage. A STRING is stored verbatim
   *  (the frontend pre-encrypts it via crypto-js AES-128-ECB); a legacy OBJECT
   *  (the old Phase 2 controller) is encrypted here. null/undefined → null. */
  private normalizeConfiguration(
    cfg: string | object | null | undefined,
  ): string | null {
    if (cfg === null || cfg === undefined) return null;
    if (typeof cfg === 'string') return cfg;
    return this.connectorFactory.encryptConfiguration(cfg as ConnectionConfig);
  }

  async findAll() {
    return this.prisma.datasource.findMany({
      where: { oid: this.currentOid() },
      orderBy: { createdAt: 'desc' },
      include: {
        tables: {
          include: {
            fields: true,
          },
        },
        _count: {
          select: { tables: true, chats: true },
        },
      },
    });
  }

  async findOne(id: number) {
    const datasource = await this.prisma.datasource.findFirst({
      where: { id, oid: this.currentOid() },
      include: {
        tables: {
          include: {
            fields: true,
          },
        },
      },
    });

    if (!datasource) {
      throw new NotFoundException(tr('datasource.not_found', { id }));
    }

    return datasource;
  }

  async update(
    id: number,
    updateDatasourceDto: Partial<DatasourceMutateInput>,
  ) {
    await this.findOne(id);

    const data: {
      name?: string;
      description?: string | null;
      type?: string;
      configuration?: string | null;
      status?: string;
    } = {};

    if (updateDatasourceDto.name !== undefined)
      data.name = updateDatasourceDto.name;
    if (updateDatasourceDto.description !== undefined)
      data.description = updateDatasourceDto.description;
    if (updateDatasourceDto.type !== undefined)
      data.type = updateDatasourceDto.type;
    if (updateDatasourceDto.configuration !== undefined)
      data.configuration = this.normalizeConfiguration(
        updateDatasourceDto.configuration,
      );
    if (updateDatasourceDto.status !== undefined)
      data.status = updateDatasourceDto.status;

    const row = await this.prisma.datasource.update({ where: { id }, data });
    // M7: a rebind (configuration/type change) can serve different data under
    // identical SQL — invalidate the workspace's query cache.
    if (
      updateDatasourceDto.configuration !== undefined ||
      updateDatasourceDto.type !== undefined
    ) {
      await this.bumpCacheRevision(row.oid);
    }
    // Re-embed when the user-facing text (name/description) changed — those
    // are the only fields the select_datasource prompt matches against.
    if (
      updateDatasourceDto.name !== undefined ||
      updateDatasourceDto.description !== undefined
    ) {
      void this.embedDatasource(row.id, row.name, row.description).catch((e) =>
        this.logger.warn(
          `datasource #${row.id} embed failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    return row;
  }

  async remove(id: number) {
    const ds = await this.findOne(id);
    const sheets = ds.type === 'excel' ? this.excelSheetNames(ds) : [];
    const row = await this.prisma.datasource.delete({ where: { id } });
    await this.bumpCacheRevision(ds.oid);
    // Imported tables are dropped when an Excel datasource is deleted.
    // Done AFTER the row is gone (best effort): a failed drop leaves orphan
    // tables, never a live datasource pointing at dropped ones.
    if (sheets.length > 0) {
      await this.excelStore.dropTables(sheets);
    }
    return row;
  }

  /** Physical excel_store tables of an Excel datasource: the configured
   *  sheets plus every synced Table row, so an unreadable configuration
   *  (decrypt returns {}) still reclaims them. */
  private excelSheetNames(ds: {
    configuration: string | null;
    tables: { tableName: string }[];
  }): string[] {
    const cfg = this.connectorFactory.decryptConfiguration(ds.configuration);
    const raw = (cfg as Record<string, unknown>).sheets;
    const configured = Array.isArray(raw)
      ? raw
          .map((s) =>
            s && typeof s === 'object'
              ? (s as { tableName?: unknown }).tableName
              : null,
          )
          .filter((n): n is string => typeof n === 'string')
      : [];
    return [...new Set([...configured, ...ds.tables.map((t) => t.tableName)])];
  }

  /** GET /datasource/ws/:oid — datasources of a workspace the caller belongs
   *  to (the embedded-app config page uses this). */
  async findByOid(oid: number, user: CurrentUserInfo) {
    if (!Number.isInteger(oid) || oid <= 0) {
      throw new BadRequestException(tr('datasource.invalid_ws_id'));
    }
    let showConfig = user.id === ADMIN_UID;
    if (!showConfig) {
      const membership = await this.prisma.userWs.findUnique({
        where: { uid_oid: { uid: user.id, oid } },
      });
      if (!membership) {
        throw new ForbiddenException(tr('datasource.ws_access_denied'));
      }
      // The route guard checks admin rights in the caller's CURRENT
      // workspace. The (frontend-decryptable) connection config is only for
      // admins of the TARGET workspace — same rule as GET /datasource/list.
      showConfig = membership.weight !== 0;
    }
    const rows = await this.prisma.datasource.findMany({
      where: { oid },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tables: true, chats: true } } },
    });
    return showConfig ? rows : rows.map((r) => ({ ...r, configuration: null }));
  }

  async testConnection(id: number) {
    const datasource = await this.loadForConnector(id);
    const result = await this.connectorFactory.withConnector(datasource, (c) =>
      c.testConnection(),
    );
    await this.setStatus(id, result.success ? 'active' : 'error');
    return result;
  }

  async getVersion(id: number) {
    const datasource = await this.loadForConnector(id);
    return this.connectorFactory.withConnector(datasource, (c) =>
      c.getVersion(),
    );
  }

  async syncTables(id: number) {
    const datasource = await this.loadForConnector(id);
    try {
      const result = await this.connectorFactory.withConnector(
        datasource,
        async (c) => {
          const tables = await c.getTables();
          for (const table of tables) {
            const existing = await this.prisma.table.findFirst({
              where: { datasourceId: id, tableName: table.tableName },
            });
            // effective comment (custom wins) keeps the vector input aligned
            // with recall's keyword scoring
            let tableId: number;
            let effectiveComment: string | null;
            if (existing) {
              const row = await this.prisma.table.update({
                where: { id: existing.id },
                data: { tableComment: table.tableComment },
              });
              tableId = row.id;
              effectiveComment = existing.customComment || table.tableComment;
            } else {
              const row = await this.prisma.table.create({
                data: {
                  datasourceId: id,
                  tableName: table.tableName,
                  tableComment: table.tableComment,
                },
              });
              tableId = row.id;
              effectiveComment = table.tableComment;
            }

            const fields = await c.getFields(table.tableName);
            await this.syncFields(tableId, fields);
            // Table embedding feeds the "choose_table_schema" selection step.
            void this.embedTable(
              tableId,
              table.tableName,
              effectiveComment,
            ).catch((e) =>
              this.logger.warn(
                `table #${tableId} embed failed: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
          return {
            success: true,
            message: '表结构同步成功',
            tableCount: tables.length,
          };
        },
      );
      // M7: a schema change can reshape `SELECT *` results under identical
      // SQL — invalidate the workspace's query cache.
      await this.bumpCacheRevision(datasource.oid);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        tr('datasource.sync_failed', { msg }),
      );
    }
  }

  /** M7: query-cache invalidation for the workspace. AWAITED on purpose:
   *  these are cold paths (update/sync/remove) and a fire-and-forget write
   *  would land at an arbitrary later point. A failed bump only means
   *  entries live until their TTL — warn, never throw. */
  private async bumpCacheRevision(oid: number): Promise<void> {
    try {
      await this.queryCache.bumpRevision(oid);
    } catch (e) {
      this.logger.warn(
        `cache revision bump failed (oid=${oid}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Preview N rows of a single table (columns + rows). */
  async previewTable(id: number, tableName: string, limit = 10) {
    const datasource = await this.loadForConnector(id);
    return this.connectorFactory.withConnector(datasource, async (c) => {
      const fields = await c.getFields(tableName);
      const rows = await c.getTableSampleData(tableName, limit);
      return {
        columns: fields.map((f) => f.fieldName),
        rows,
      };
    });
  }

  /** Execute a (validated, read-only) SQL statement against the datasource.
   *  MetaDataImprove M7: this is the single execution funnel every query
   *  (chat / dashboard / MCP / regression) goes through, so the query-cost
   *  guards live here — quota.max_rows caps rows (a caller's smaller limit
   *  wins, a larger one is clamped), and with cache.enabled repeated
   *  effective SQL (appendLimit output — deterministic, so hashing it matches
   *  what the connector executes) is served from Postgres until TTL/revision
   *  invalidation. */
  async execSql(id: number, sql: string, limit?: number) {
    const datasource = await this.loadForConnector(id);
    const oid = this.currentOid();
    const cfg = await resolveEmbeddingConfig(this.prisma);
    const max = Math.min(limit ?? cfg.quotaMaxRows, cfg.quotaMaxRows);
    if (!cfg.cacheEnabled) {
      return this.connectorFactory.withConnector(datasource, (c) =>
        c.execSql(sql, max),
      );
    }
    const finalSql = appendLimit(sql, max);
    const sqlHash = effectiveSqlHash(finalSql);
    const revision = await this.queryCache.currentRevision(oid);
    const hit = await this.queryCache.lookup(oid, id, sqlHash, revision);
    if (hit) return hit;
    const result = await this.connectorFactory.withConnector(datasource, (c) =>
      c.execSql(sql, max),
    );
    void this.queryCache.store(
      oid,
      id,
      sqlHash,
      finalSql,
      result,
      revision,
      cfg.cacheTtlSeconds,
    );
    return result;
  }

  /** Run `fn` against the datasource's live connection inside ONE connector
   *  session (workspace-scoped, Excel sheets restricted to this datasource).
   *  The dimension-enum collector batches its DISTINCT probes through here
   *  (MetaDataImprove M3.3) so a run opens the pool once, not per field. */
  async withConnection<T>(
    id: number,
    fn: (connector: DbConnector) => Promise<T>,
  ): Promise<T> {
    const datasource = await this.loadForConnector(id);
    return this.connectorFactory.withConnector(datasource, fn);
  }

  /** Build the M-Schema string (tables + FK graph) for the SQL prompt.
   *  When `tableIds` is provided, narrow to that subset first (the embedding
   *  pre-filter feeds this); `buildMSchema` still drops unchecked tables/fields
   *  on top. Undefined `tableIds` = all tables (current Phase 2 behavior).
   *  `semantics` (MetaDataImprove M2) injects curated meanings over comments.
   *  Row-id maps resolve the X6 cell ids the relation editor stores in
   *  tableRelation (M3.1). */
  async getMSchema(
    id: number,
    tableIds?: number[],
    semantics?: MSchemaSemantics,
  ) {
    const ds = await this.findOne(id);
    const tables = tableIds
      ? ds.tables.filter((t) => tableIds.includes(t.id))
      : ds.tables;
    return buildMSchema({
      datasourceName: ds.name,
      tables: tables.map((t) => ({
        tableName: t.tableName,
        tableComment: t.tableComment,
        customComment: t.customComment,
        checked: t.checked,
        fields: t.fields.map((f) => ({
          fieldName: f.fieldName,
          fieldType: f.fieldType,
          fieldComment: f.fieldComment,
          customComment: f.customComment,
          isPrimaryKey: f.isPrimaryKey,
          fieldIndex: f.fieldIndex,
          checked: f.checked,
        })),
      })),
      tableRelation: ds.tableRelation,
      relationIdNames: relationIdNamesOf(ds.tables),
      semantics,
    });
  }

  /** Recall the most relevant tables for a question (the "embedding 选表"
   *  step) — keyword-fused ranking:
   *  α·vectorSimilarity + (1-α)·keywordScore over ALL checked tables, exact
   *  keyword hits (the question names the table) first, then explicit-mention
   *  retention + rank-fill. `keywords` (already extracted + terminology-
   *  expanded) replaces both the vector query and the keyword source when
   *  present; without keywords (or keywordEnabled off) the ranking is pure
   *  vector similarity (α=1) — retention still applies.
   *
   *  Degradation: a vector embed/search failure only zeroes the vector
   *  scores (a vector outage must not drop candidates); when embedding or
   *  vector is entirely unavailable — or tableEnabled is off — returns [] so
   *  the caller falls back to getMSchema(id) (all checked tables). */
  async recallTables(
    datasourceId: number,
    question: string,
    opts?: {
      topK?: number;
      keywords?: string | null;
      config?: EmbeddingConfig;
    },
  ): Promise<TableWithFields[]> {
    const q = question.trim();
    // Workspace guard before touching table rows: a caller-supplied foreign
    // datasource id must not leak its table/field names through recall.
    const owned = await this.prisma.datasource.findFirst({
      where: { id: datasourceId, oid: this.currentOid() },
      select: { id: true },
    });
    if (!owned) return [];
    if (!q || !this.embedding.available || !this.vector.available) return [];
    const cfg = opts?.config ?? (await resolveEmbeddingConfig(this.prisma));
    if (!cfg.tableEnabled) return [];
    const count = Math.max(1, Math.floor(opts?.topK ?? cfg.tableCount));
    const keywords = (opts?.keywords ?? '').trim();

    try {
      const rows = await this.prisma.table.findMany({
        where: { datasourceId, checked: true },
        include: {
          fields: {
            select: {
              fieldName: true,
              fieldComment: true,
              customComment: true,
            },
          },
        },
      });
      if (rows.length === 0) return [];

      // vector similarity per table id (1 - cosine distance); failures zero
      // the vector layer only
      const simById = new Map<number, number>();
      try {
        const vec = await this.embedding.embed(keywords || q);
        const hits = await this.vector.search('table', vec, rows.length);
        for (const h of hits) {
          const id = Number(h.id);
          // hits are distance-ordered — keep the first (nearest) per id
          if (!simById.has(id)) simById.set(id, 1 - h.distance);
        }
      } catch (e) {
        this.logger.warn(
          `table vector search failed for datasource #${datasourceId}, vector scores zeroed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const useKeywords = cfg.keywordEnabled && keywords.length > 0;
      const ranked = rankTables(
        rows.map((t) => ({
          row: t,
          id: t.id,
          tableName: t.tableName,
          comment: t.customComment || t.tableComment || '',
          vectorScore: simById.get(t.id) ?? 0,
          keywordScore: useKeywords
            ? calcKeywordScore(
                keywords,
                t.tableName,
                t.customComment || t.tableComment || '',
                t.fields,
              )
            : 0,
        })),
        q,
        // pure-vector pass = α 1 (fusion degenerates to the vector score)
        { alpha: useKeywords ? cfg.tableAlpha : 1, count },
      );
      return ranked.map((r) => r.row);
    } catch (e) {
      this.logger.warn(
        `table recall failed for datasource #${datasourceId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  }

  /** Read the user-edited FK edge list for a datasource. */
  async getTableRelation(id: number) {
    const ds = await this.loadForConnector(id);
    return ds.tableRelation ?? [];
  }

  /** Replace the whole FK edge list (the relation editor saves atomically).
   *  MetaDataImprove M3 follow-up: each save appends an immutable snapshot in
   *  the same transaction (version + 1), so the graph is reviewable later.
   *  Runtime continues to read `Datasource.tableRelation` — the latest row. */
  async saveTableRelation(id: number, edges: unknown[]) {
    const oid = this.currentOid();
    const changedBy = RequestContext.getUserId() ?? null;
    const payload = (edges ?? []) as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.datasource.findFirst({
        where: { id, oid },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException(tr('datasource.not_found', { id }));
      }
      const updated = await tx.datasource.update({
        where: { id },
        data: {
          tableRelation: payload,
          relationVersion: { increment: 1 },
        },
        select: { relationVersion: true },
      });
      await tx.datasourceRelationVersion.create({
        data: {
          datasourceId: id,
          version: updated.relationVersion,
          snapshot: payload,
          changedBy,
        },
      });
      return { success: true, edges, version: updated.relationVersion };
    });
  }

  /** Append-only relation-graph history (newest first). */
  async getTableRelationVersions(id: number) {
    await this.loadForConnector(id);
    return this.prisma.datasourceRelationVersion.findMany({
      where: { datasourceId: id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        snapshot: true,
        changedBy: true,
        note: true,
        createdAt: true,
      },
    });
  }

  /** Restore one saved relation snapshot (MetaDataImprove M3 follow-up).
   *  Restore is a normal write with save's authority: a NEW version is
   *  appended and the old history rows stay untouched (no approval round,
   *  no in-place rewrite). The snapshot is written back verbatim so the
   *  editor returns to the exact canvas that was saved. */
  async restoreTableRelation(id: number, version: number) {
    const changedBy = RequestContext.getUserId() ?? null;
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.datasource.findFirst({
        where: { id, oid: this.currentOid() },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException(tr('datasource.not_found', { id }));
      }
      const snapshot = await tx.datasourceRelationVersion.findFirst({
        where: { datasourceId: id, version },
      });
      if (!snapshot) {
        throw new NotFoundException(
          tr('datasource.relation_version_not_found', { id, version }),
        );
      }
      const payload = snapshot.snapshot as Prisma.InputJsonValue;
      const updated = await tx.datasource.update({
        where: { id },
        data: {
          tableRelation: payload,
          relationVersion: { increment: 1 },
        },
        select: { relationVersion: true },
      });
      await tx.datasourceRelationVersion.create({
        data: {
          datasourceId: id,
          version: updated.relationVersion,
          snapshot: payload,
          changedBy,
          note: tr('datasource.relation_restore_note', { version }),
        },
      });
      return {
        success: true as const,
        version: updated.relationVersion,
        restoredFrom: version,
      };
    });
  }

  /** Semantic diff between two saved relation versions (default: the newest
   *  saved version, i.e. the graph the runtime currently reads). Both
   *  snapshots are normalized to FK edges with the CURRENT Table/Field rows,
   *  so node positioning changes never show up as a diff and edges whose
   *  endpoints were dropped since then are ignored. */
  async compareTableRelation(
    id: number,
    fromVersion: number,
    toVersion?: number,
  ) {
    await this.loadForConnector(id);
    // Newest version only — never load the whole history (each snapshot is a
    // full graph; a long-lived datasource can have many).
    const newest = await this.prisma.datasourceRelationVersion.findFirst({
      where: { datasourceId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const target = toVersion ?? newest?.version;
    if (target === undefined) {
      throw new NotFoundException(
        tr('datasource.relation_version_not_found', {
          id,
          version: fromVersion,
        }),
      );
    }
    const versions = await this.prisma.datasourceRelationVersion.findMany({
      where: {
        datasourceId: id,
        version: { in: [...new Set([fromVersion, target])] },
      },
      select: { version: true, snapshot: true },
    });
    const fromRow = versions.find((v) => v.version === fromVersion);
    if (!fromRow) {
      throw new NotFoundException(
        tr('datasource.relation_version_not_found', {
          id,
          version: fromVersion,
        }),
      );
    }
    const toRow = versions.find((v) => v.version === target);
    if (!toRow) {
      throw new NotFoundException(
        tr('datasource.relation_version_not_found', {
          id,
          version: target,
        }),
      );
    }
    const tables = await this.prisma.table.findMany({
      where: { datasourceId: id },
      select: {
        id: true,
        tableName: true,
        fields: { select: { id: true, fieldName: true } },
      },
    });
    const names = relationIdNamesOf(tables);
    return {
      fromVersion,
      toVersion: toRow.version,
      ...diffRelationEdges(
        normalizeTableRelation(fromRow.snapshot, names),
        normalizeTableRelation(toRow.snapshot, names),
      ),
    };
  }

  // ─── action-style route service methods ────────────────────────────

  /** POST /datasource/check — test a config object (not yet persisted).
   *  Returns boolean; never throws (a bad config surfaces as false). */
  async checkByConf(dto: {
    type: string;
    configuration: string | null;
  }): Promise<boolean> {
    try {
      const result = await this.connectorFactory.withConnector(dto, (c) =>
        c.testConnection(),
      );
      return result.success;
    } catch {
      return false;
    }
  }

  /** GET /datasource/check/:id — test a stored datasource. Returns boolean;
   *  never throws (missing row / dead connection both surface as false). */
  async checkById(id: number): Promise<boolean> {
    try {
      const result = await this.testConnection(id);
      return result.success;
    } catch {
      return false;
    }
  }

  /** POST /datasource/getTablesByConf — live tables for a config object.
   *  Returns [{tableName, tableComment}] (camelCase; the connector's
   *  TableMeta already has this shape). */
  async getTablesByConf(dto: { type: string; configuration: string | null }) {
    return this.connectorFactory.withConnector(dto, (c) => c.getTables());
  }

  /** POST /datasource/getTables/:id — live tables for a stored datasource
   *  (legacy route; unused by the current frontend but kept for parity). */
  async getTables(id: number) {
    const ds = await this.loadForConnector(id);
    return this.connectorFactory.withConnector(ds, (c) => c.getTables());
  }

  /** POST /datasource/getFields/:id/:table_name — live fields for a table in
   *  a stored datasource. Returns [{fieldName, fieldType, fieldComment}]
   *  (camelCase). */
  async getFields(id: number, tableName: string) {
    const ds = await this.loadForConnector(id);
    return this.connectorFactory.withConnector(ds, (c) =>
      c.getFields(tableName),
    );
  }

  /** POST /datasource/getSchemaByConf — schema names for a config object.
   *  Engines without a schema layer (sqlite/mysql) return []. The frontend
   *  only renders the Schema selector for
   *  sqlServer/pg/oracle/dm/redshift/kingbase — of those only
   *  pg has a connector here. */
  async getSchemaByConf(dto: {
    type: string;
    configuration: string | null;
  }): Promise<string[]> {
    return this.connectorFactory.withConnector(dto, (c) => c.getSchemas());
  }

  /** POST /datasource/tableList/:id — persisted Table rows ordered by
   *  table_name. The controller maps to snake_case via toTableSnake. */
  async tableList(id: number) {
    await this.assertDatasourceOwned(id);
    return this.prisma.table.findMany({
      where: { datasourceId: id },
      orderBy: { tableName: 'asc' },
    });
  }

  /** POST /datasource/fieldList/:id (id = TABLE id) — persisted Field rows
   *  ordered by field_index, optionally filtered by field_name (case-insensitive
   *  substring match, PostgreSQL ILIKE). The controller maps to snake_case via
   *  toFieldSnake. */
  async fieldList(tableId: number, fieldName?: string) {
    const where: {
      tableId: number;
      table: { datasource: { oid: number } };
      fieldName?: Prisma.StringFilter;
    } = { tableId, table: { datasource: { oid: this.currentOid() } } };
    if (fieldName && fieldName.trim()) {
      where.fieldName = { contains: fieldName.trim(), mode: 'insensitive' };
    }
    return this.prisma.field.findMany({
      where,
      orderBy: { fieldIndex: 'asc' },
    });
  }

  /** POST /datasource/editTable — persist ONLY checked + custom_comment by
   *  id (table_name/table_comment are ignored). */
  async editTable(body: TableEditBody): Promise<void> {
    const data: { customComment?: string | null; checked?: boolean } = {};
    if (body.custom_comment !== undefined)
      data.customComment = body.custom_comment;
    if (body.checked !== undefined) data.checked = body.checked;
    // Resolve through the parent datasource so a foreign table id cannot be
    // edited by guessing it. The ownership read and the write share ONE
    // transaction: a concurrent delete can't turn the 404 into a P2025 500.
    const row = await this.prisma.$transaction(async (tx) => {
      const owned = await tx.table.findFirst({
        where: { id: body.id, datasource: { oid: this.currentOid() } },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException(
          tr('datasource.table_not_found', { id: body.id }),
        );
      }
      return tx.table.update({ where: { id: body.id }, data });
    });
    // custom_comment participates in the vector input (effective comment),
    // so an edit invalidates the cached vector — re-embed fire-and-forget.
    void this.embedTable(
      row.id,
      row.tableName,
      row.customComment || row.tableComment,
    ).catch((e) =>
      this.logger.warn(
        `table #${row.id} embed failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** POST /datasource/editField — persist ONLY checked + custom_comment by
   *  id (field_name/field_type are ignored). */
  async editField(body: FieldEditBody): Promise<void> {
    const data: { customComment?: string | null; checked?: boolean } = {};
    if (body.custom_comment !== undefined)
      data.customComment = body.custom_comment;
    if (body.checked !== undefined) data.checked = body.checked;
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.field.findFirst({
        where: {
          id: body.id,
          table: { datasource: { oid: this.currentOid() } },
        },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException(
          tr('datasource.field_not_found', { id: body.id }),
        );
      }
      await tx.field.update({ where: { id: body.id }, data });
    });
  }

  /** Reconcile persisted tables for a datasource against an incoming
   *  selection.
   *  For each {table_name, table_comment}: if a Table row exists, update
   *  ONLY tableComment (custom_comment/checked survive); else insert a new
   *  row with checked=true + customComment=table_comment. Re-sync fields per
   *  table from the source DB. Delete tables (and their fields) whose
   *  table_name is NOT in the incoming set. An empty incoming list clears
   *  all tables + fields for the datasource. */
  async syncTable(
    id: number,
    incoming: { table_name: string; table_comment?: string | null }[],
  ): Promise<void> {
    const ds = await this.loadForConnector(id);
    const incomingNames = new Set(incoming.map((t) => t.table_name));
    await this.connectorFactory.withConnector(ds, async (c) => {
      const liveTables = await c.getTables();
      const liveNames = new Set(liveTables.map((t) => t.tableName));
      for (const item of incoming) {
        if (!liveNames.has(item.table_name)) continue; // gone from source
        const existing = await this.prisma.table.findFirst({
          where: { datasourceId: id, tableName: item.table_name },
        });
        let tableId: number;
        let effectiveComment: string | null;
        if (existing) {
          const row = await this.prisma.table.update({
            where: { id: existing.id },
            data: { tableComment: item.table_comment ?? null },
          });
          tableId = row.id;
          effectiveComment =
            existing.customComment || item.table_comment || null;
        } else {
          const created = await this.prisma.table.create({
            data: {
              datasourceId: id,
              tableName: item.table_name,
              tableComment: item.table_comment ?? null,
              customComment: item.table_comment ?? null,
              checked: true,
            },
          });
          tableId = created.id;
          effectiveComment = item.table_comment ?? null;
        }
        const fields = await c.getFields(item.table_name);
        await this.syncFields(tableId, fields);
        void this.embedTable(tableId, item.table_name, effectiveComment).catch(
          (e) =>
            this.logger.warn(
              `table #${tableId} embed failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        );
      }
      // Persist the "selected/total" snapshot for the num badge.
      // Fire-and-forget — a failed snapshot write must not break table sync.
      const selected = incoming.filter((t) =>
        liveNames.has(t.table_name),
      ).length;
      // Awaited (unlike embedTable): num is a user-visible field, so the
      // "selected/total" snapshot must be committed before syncTable returns.
      await this.persistNum(id, selected, liveTables.length).catch((e) =>
        this.logger.warn(
          `datasource #${id} num snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    });
    // Delete unlisted tables + their orphan fields (by table_name reconcile).
    if (incomingNames.size === 0) {
      await this.prisma.field.deleteMany({
        where: { table: { datasourceId: id } },
      });
      await this.prisma.table.deleteMany({ where: { datasourceId: id } });
    } else {
      const unlisted = await this.prisma.table.findMany({
        where: { datasourceId: id, tableName: { notIn: [...incomingNames] } },
        select: { id: true },
      });
      if (unlisted.length > 0) {
        const unlistedIds = unlisted.map((t) => t.id);
        await this.prisma.field.deleteMany({
          where: { tableId: { in: unlistedIds } },
        });
        await this.prisma.table.deleteMany({
          where: { id: { in: unlistedIds } },
        });
      }
    }
  }

  /** Persist the "selected/total" table-count snapshot (e.g. "3/10").
   *  Called from syncTable once the live table list + incoming selection
   *  are known. The mapper prefers this stored value over the derived count. */
  private async persistNum(
    id: number,
    selected: number,
    total: number,
  ): Promise<void> {
    await this.prisma.datasource.update({
      where: { id },
      data: { num: `${selected}/${total}` },
    });
  }

  /** POST /datasource/chooseTables/:id — check the connection first,
   *  then reconcile the persisted tables against the selection. */
  async chooseTables(
    id: number,
    incoming: { table_name: string; table_comment?: string | null }[],
  ): Promise<{ success: true }> {
    const ok = await this.checkById(id);
    if (!ok) {
      throw new InternalServerErrorException(
        tr('datasource.connection_failed'),
      );
    }
    await this.syncTable(id, incoming);
    return { success: true };
  }

  /** POST /datasource/previewData/:id (id = DS id) — sample rows projected to
   *  the table's checked fields. The request body's `fields` array is IGNORED;
   *  checked fields are loaded from the persisted Field rows for
   *  body.table.id. Returns {fields, data, sql};
   *  `sql` is empty (the frontend doesn't consume it). */
  async previewData(
    dsId: number,
    body: { table: { id: number }; fields?: unknown[] },
  ): Promise<{
    fields: string[];
    data: Record<string, unknown>[];
    sql: string;
  }> {
    const table = await this.prisma.table.findFirst({
      where: {
        id: body.table.id,
        datasource: { oid: this.currentOid() },
      },
    });
    if (!table) {
      throw new NotFoundException(
        tr('datasource.table_not_found', { id: body.table.id }),
      );
    }
    // 97d29a4d (IDOR): the body's table id must belong to the path's
    // datasource — otherwise a caller could read another datasource's table
    // sample rows through this connection.
    if (table.datasourceId !== dsId) {
      throw new BadRequestException(
        tr('datasource.table_not_in_ds', { tableId: table.id, dsId }),
      );
    }
    const persisted = await this.prisma.field.findMany({
      where: { tableId: table.id },
      orderBy: { fieldIndex: 'asc' },
    });
    const checkedNames = persisted
      .filter((f) => f.checked)
      .map((f) => f.fieldName);
    if (checkedNames.length === 0) {
      return { fields: [], data: [], sql: '' };
    }
    const ds = await this.loadForConnector(dsId);
    return this.connectorFactory.withConnector(ds, async (c) => {
      const rows = await c.getTableSampleData(table.tableName, 100);
      const liveFields = await c.getFields(table.tableName);
      const liveNames = liveFields.map((f) => f.fieldName);
      const rowObjects = rows.map((r) =>
        Object.fromEntries(
          liveNames.map((name, i) => [name, r[i]] as [string, unknown]),
        ),
      );
      const projectedData = rowObjects.map((row) =>
        Object.fromEntries(
          checkedNames.map((n) => [n, row[n]] as [string, unknown]),
        ),
      );
      return { fields: checkedNames, data: projectedData, sql: '' };
    });
  }

  /** POST /datasource/syncFields/:id (id = TABLE id) — re-fetch fields for
   *  one table from the source DB and merge. Throws if the table no longer
   *  exists in the source. */
  async syncFieldsByTableId(tableId: number): Promise<void> {
    const table = await this.prisma.table.findFirst({
      where: {
        id: tableId,
        datasource: { oid: this.currentOid() },
      },
    });
    if (!table) {
      throw new NotFoundException(
        tr('datasource.table_not_found', { id: tableId }),
      );
    }
    const ds = await this.loadForConnector(table.datasourceId);
    await this.connectorFactory.withConnector(ds, async (c) => {
      const liveTables = await c.getTables();
      const liveNames = new Set(liveTables.map((t) => t.tableName));
      if (!liveNames.has(table.tableName)) {
        throw new InternalServerErrorException(
          `源数据库中已不存在表 ${table.tableName}`,
        );
      }
      const fields = await c.getFields(table.tableName);
      await this.syncFields(tableId, fields);
    });
    void this.embedTable(
      table.id,
      table.tableName,
      table.customComment || table.tableComment,
    ).catch((e) =>
      this.logger.warn(
        `table #${table.id} embed failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** GET /datasource/exportDsSchema/:id — xlsx blob of the datasource schema.
   *  id=0 → template (sample workbook). Real id → one "数据表列表" index sheet
   *  (Sheet名称/表名/表备注) + one sheet per table (字段名/字段备注), using
   *  the user's custom_comment remarks. */
  async exportDsSchema(id: number): Promise<Buffer> {
    if (id === 0) {
      return this.buildDsSchemaTemplate();
    }
    await this.loadForConnector(id);
    const tables = await this.prisma.table.findMany({
      where: { datasourceId: id },
      orderBy: { tableName: 'asc' },
    });
    if (tables.length === 0) {
      throw new BadRequestException(tr('datasource.no_tables_to_export'));
    }
    const wb = new ExcelJS.Workbook();
    const indexSheet = wb.addWorksheet('数据表列表');
    indexSheet.columns = [
      { header: 'Sheet名称', key: 'sheet', width: 20 },
      { header: tr('datasource.col_table_name'), key: 'name', width: 40 },
      { header: tr('datasource.col_table_comment'), key: 'comment', width: 30 },
    ];
    let i = 0;
    for (const t of tables) {
      const sheetName = `Sheet${i++}`;
      indexSheet.addRow({
        sheet: sheetName,
        name: t.tableName,
        comment: t.customComment ?? '',
      });
      const sheet = wb.addWorksheet(sheetName);
      sheet.columns = [
        { header: tr('datasource.col_field_name'), key: 'name', width: 30 },
        {
          header: tr('datasource.col_field_comment'),
          key: 'comment',
          width: 30,
        },
      ];
      const fields = await this.prisma.field.findMany({
        where: { tableId: t.id },
        orderBy: { fieldIndex: 'asc' },
      });
      for (const f of fields) {
        sheet.addRow({ name: f.fieldName, comment: f.customComment ?? '' });
      }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async buildDsSchemaTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const index = wb.addWorksheet('数据表列表');
    index.columns = [
      { header: 'Sheet名称', key: 'sheet', width: 20 },
      { header: tr('datasource.col_table_name'), key: 'name', width: 40 },
      { header: tr('datasource.col_table_comment'), key: 'comment', width: 30 },
    ];
    index.addRow({ sheet: 'Sheet1', name: '数据表1', comment: '示例表' });
    index.addRow({ sheet: 'Sheet2', name: '数据表2', comment: '示例表' });
    for (const name of ['Sheet1', 'Sheet2']) {
      const s = wb.addWorksheet(name);
      s.columns = [
        { header: tr('datasource.col_field_name'), key: 'name', width: 30 },
        {
          header: tr('datasource.col_field_comment'),
          key: 'comment',
          width: 30,
        },
      ];
      s.addRow({ name: 'id', comment: '主键' });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // Minimal row load for connection operations — avoids eagerly pulling every
  // table/field when all we need is { id, type, configuration }. Scoped to the
  // current workspace: a foreign id is indistinguishable from a missing one.
  private async loadForConnector(id: number) {
    const datasource = await this.prisma.datasource.findFirst({
      where: { id, oid: this.currentOid() },
    });
    if (!datasource) {
      throw new NotFoundException(tr('datasource.not_found', { id }));
    }
    return datasource;
  }

  /** Workspace id resolved from the request context (JwtAuthGuard writes the
   *  DB-authoritative User.oid there). */
  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  /** Cheap ownership check for endpoints whose child rows are looked up by
   *  their own id (tableList). */
  private async assertDatasourceOwned(id: number): Promise<void> {
    const owned = await this.prisma.datasource.findFirst({
      where: { id, oid: this.currentOid() },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException(tr('datasource.not_found', { id }));
    }
  }

  private async setStatus(id: number, status: string) {
    await this.prisma.datasource.update({ where: { id }, data: { status } });
  }

  // Non-destructive field sync: merge by fieldName so user-edited
  // customComment / checked flags survive re-syncs. Dropped columns are
  // removed (they no longer exist in the source); new columns are appended.
  private async syncFields(tableId: number, fields: FieldMeta[]) {
    const existing = await this.prisma.field.findMany({
      where: { tableId },
    });
    const existingByName = new Map(
      existing.map((f) => [f.fieldName, f] as const),
    );
    const incomingNames = new Set(fields.map((f) => f.fieldName));

    const stale = existing.filter((f) => !incomingNames.has(f.fieldName));
    if (stale.length > 0) {
      await this.prisma.field.deleteMany({
        where: { id: { in: stale.map((f) => f.id) } },
      });
    }

    for (const field of fields) {
      const current = existingByName.get(field.fieldName);
      if (current) {
        await this.prisma.field.update({
          where: { id: current.id },
          data: {
            fieldType: field.fieldType,
            fieldComment: field.fieldComment,
            isPrimaryKey: field.isPrimaryKey,
            fieldIndex: field.fieldIndex,
          },
        });
      } else {
        await this.prisma.field.create({
          data: {
            tableId,
            fieldName: field.fieldName,
            fieldType: field.fieldType,
            fieldComment: field.fieldComment,
            isPrimaryKey: field.isPrimaryKey,
            fieldIndex: field.fieldIndex,
          },
        });
      }
    }
  }

  /** Embed the datasource's name+description and upsert into the 'datasource'
   *  vector collection. Also persists the vector to the Prisma `embedding`
   *  Json column (source of truth, rebuildable). No-op when embedding is not
   *  configured — recall then falls back to name ILIKE matching. */
  private async embedDatasource(
    id: number,
    name: string,
    description: string | null,
  ): Promise<void> {
    if (!this.embedding.available) return;
    const text = embedRowText(name, description);
    if (!text.trim()) return;
    const vec = await this.embedding.embed(text);
    await this.prisma.datasource.update({
      where: { id },
      data: { embedding: vec },
    });
    if (this.vector.available) await this.vector.upsert('datasource', id, vec);
  }

  /** Embed a table's name + EFFECTIVE comment (custom wins — callers pass
   *  `customComment || tableComment`, matching recall's keyword scoring)
   *  into the 'table' vector collection. Same shape as embedDatasource;
   *  used by the choose_table_schema step. */
  private async embedTable(
    id: number,
    name: string,
    comment: string | null,
  ): Promise<void> {
    if (!this.embedding.available) return;
    const text = embedRowText(name, comment);
    if (!text.trim()) return;
    const vec = await this.embedding.embed(text);
    await this.prisma.table.update({
      where: { id },
      data: { embedding: vec },
    });
    if (this.vector.available) await this.vector.upsert('table', id, vec);
  }
}
