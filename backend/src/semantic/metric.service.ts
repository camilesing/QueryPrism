// MetricService — the M4 metric dictionary (atomic metrics / modifiers /
// time periods / derived metrics / composite metrics) on the shared
// governed-dictionary governance: three scope layers, append-only version
// history, cross-layer approval (SemanticChangeRequest entityType 'metric').
//
// Natural key (scope layer, kind, code) — uniqueness is enforced inside the
// write transaction (Prisma cannot express conditional unique indexes).
// Composite expressions reference other metric codes by identifier tokens
// (see metric-policy); dangling references and cycles skip at RUNTIME
// resolution instead of failing the request.
//
// Known limitation: matchDefinitions matches by literal name/alias inclusion
// — no vector recall yet (metric-policy header).
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { tr } from '../common/i18n/translate';
import { pickEffectiveRow, type SemanticScope } from './semantic-policy';
import {
  METRIC_KINDS,
  definitionProblem,
  expressionProblem,
  matchMetricDefinitions,
  parseMetricDefinition,
  type MetricKind,
  type MetricMatchResult,
} from './metric-policy';
import {
  GovernedDictService,
  type GovernedRow,
  type PrismaTx,
} from './governed-dict.service';
import { DataStandardService } from './standard.service';
import { toMetricDefSnake, type MetricDefSnake } from './metric-snake-mapper';
import {
  toVersionSnake,
  type SemanticPage,
  type SemanticVersionSnake,
} from './semantic-snake-mapper';

/** Codes are identifier tokens — they must survive the composite-expression
 *  tokenizer (metric-policy CODE_TOKEN). */
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface MetricUpsertInfo {
  kind: MetricKind;
  scope: SemanticScope;
  code: string;
  name: string;
  aliases?: string[];
  description?: string;
  unit?: string;
  /** Kind-specific strict payload (validated via parseMetricDefinition). */
  definition: Record<string, unknown>;
  enabled?: boolean;
  note?: string;
}

type MetricTarget = {
  scope: SemanticScope;
  oid: number | null;
  ownerUid: number | null;
};

@Injectable()
export class MetricService extends GovernedDictService<MetricUpsertInfo> {
  protected readonly entityType = 'metric' as const;

  constructor(
    prisma: PrismaService,
    private readonly standards: DataStandardService,
  ) {
    super(prisma);
  }

  /** The shared M4 inbox review (`system/metric/request/review`): dispatches
   *  by the request's entityType so a standard proposal is applied by the
   *  standard dictionary (its payload shape is not a metric payload). */
  async reviewShared(
    id: number,
    approve: boolean,
    reviewNote?: string,
  ): Promise<void> {
    const request = await this.prisma.semanticChangeRequest.findUnique({
      where: { id },
      select: { entityType: true, status: true },
    });
    if (!request || request.status !== 'pending') {
      throw new BadRequestException(this.t('request_not_pending'));
    }
    const service = request.entityType === 'standard' ? this.standards : this;
    return service.review(id, approve, reviewNote);
  }

  // ---- read: admin page -------------------------------------------------

  /** Paginated list, visible layers only; `table_exists` flags dangling
   *  atomic/modifier bindings (bound table dropped/renamed in the source). */
  async page(
    kind: MetricKind,
    currentPage: number,
    pageSize: number,
    filters?: { scope?: string; datasourceId?: number; keyword?: string },
  ): Promise<SemanticPage<MetricDefSnake>> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    // Keyword narrows WITHIN the visible layers — the visibility OR stays a
    // separate AND clause (overwriting it would leak other workspaces' rows).
    const andClauses: Prisma.MetricDefWhereInput[] = [
      this.visibleFilter(actor),
    ];
    if (filters?.keyword?.trim()) {
      const kw = filters.keyword.trim();
      andClauses.push({
        OR: [
          { code: { contains: kw, mode: 'insensitive' } },
          { name: { contains: kw, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.MetricDefWhereInput = { kind, AND: andClauses };
    if (filters?.scope) where.scope = filters.scope;
    const rows = await this.prisma.metricDef.findMany({
      where,
      orderBy: [{ code: 'asc' }],
    });
    // Datasource filter applies to the ds-bound kinds' definitions only
    // (period/derived/composite carry no datasourceId of their own).
    const filtered = filters?.datasourceId
      ? rows.filter((r) => {
          if (r.kind !== 'atomic' && r.kind !== 'modifier') return true;
          const def = parseMetricDefinition(r.kind, r.definition);
          return def && 'datasourceId' in def
            ? def.datasourceId === filters.datasourceId
            : true;
        })
      : rows;
    const total_count = filtered.length;
    const total_pages = total_count > 0 ? Math.ceil(total_count / ps) : 0;
    const cpClamped = total_pages > 0 ? Math.min(cp, total_pages) : 1;
    const start = (cpClamped - 1) * ps;
    const pageRows = filtered.slice(start, start + ps);

    // Dangling check for ds-bound kinds: which (datasourceId, tableName)
    // pairs still exist as synced Table rows?
    const bindings = new Map<string, boolean>();
    for (const r of pageRows) {
      if (r.kind !== 'atomic' && r.kind !== 'modifier') continue;
      const def = parseMetricDefinition(r.kind, r.definition);
      if (def && 'datasourceId' in def) {
        bindings.set(`${def.datasourceId}:${def.tableName}`, false);
      }
    }
    for (const key of bindings.keys()) {
      const [dsId, tableName] = key.split(':');
      const table = await this.prisma.table.findFirst({
        where: { datasourceId: Number(dsId), tableName },
        select: { id: true },
      });
      if (table) bindings.set(key, true);
    }
    const data = pageRows.map((r) => {
      let exists = true;
      if (r.kind === 'atomic' || r.kind === 'modifier') {
        const def = parseMetricDefinition(r.kind, r.definition);
        if (def && 'datasourceId' in def) {
          exists = bindings.get(`${def.datasourceId}:${def.tableName}`) ?? true;
        }
      }
      return toMetricDefSnake(r, exists);
    });
    return {
      current_page: cpClamped,
      page_size: ps,
      total_count,
      total_pages,
      data,
    };
  }

  /** Version history of one entry (newest first). */
  async versions(id: number): Promise<SemanticVersionSnake[]> {
    const rows = await this.prisma.metricDefVersion.findMany({
      where: { entityId: id },
      orderBy: { version: 'desc' },
    });
    return rows.map((r) => toVersionSnake(r as never));
  }

  // ---- runtime: prompt integration --------------------------------------

  /** Match a question against the actor-visible enabled metric rows of ONE
   *  datasource and render the `<metric_definitions>` prompt block. Tables of
   *  every rendered metric are returned so the chat pipeline can force-stuff
   *  them into the M-Schema. */
  async matchDefinitions(
    datasourceId: number,
    question: string,
    max: number,
  ): Promise<MetricMatchResult> {
    const actor = this.actor();
    const rows = await this.prisma.metricDef.findMany({
      where: { enabled: true, ...this.visibleFilter(actor) },
    });
    const timeFields = await this.timeFieldsByTable(datasourceId, actor);
    return matchMetricDefinitions(rows, datasourceId, question, max, (t) =>
      timeFields.get(t),
    );
  }

  /** Default time field per table: the effective (layer-priority) FieldSemantic
   *  row with role=time. Feeds the derived-metric time hint when the derived
   *  definition carries no explicit timeField. */
  private async timeFieldsByTable(
    datasourceId: number,
    actor: { oid: number; id: number },
  ): Promise<Map<string, string>> {
    const rows = await this.prisma.fieldSemantic.findMany({
      where: {
        datasourceId,
        role: 'time',
        enabled: true,
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: actor.oid },
          { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
        ],
      },
    });
    const byTable = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byTable.get(r.tableName) ?? [];
      list.push(r);
      byTable.set(r.tableName, list);
    }
    const out = new Map<string, string>();
    for (const [table, list] of byTable) {
      const effective = pickEffectiveRow(list);
      if (effective) out.set(table, effective.fieldName);
    }
    return out;
  }

  // ---- governance hooks ---------------------------------------------------

  protected validateInfo(info: MetricUpsertInfo): void {
    if (!METRIC_KINDS.includes(info.kind)) {
      throw new BadRequestException(this.t('invalid_kind'));
    }
    if (!info.code?.trim() || !CODE_PATTERN.test(info.code.trim())) {
      throw new BadRequestException(this.t('invalid_code'));
    }
    if (!info.name?.trim()) {
      throw new BadRequestException(this.t('missing_fields'));
    }
    const def = parseMetricDefinition(info.kind, info.definition);
    if (!def) {
      throw new BadRequestException(this.t('definition_invalid'));
    }
    const problem = definitionProblem(info.kind, def);
    if (problem) throw new BadRequestException(tr(problem));
    if (info.kind === 'composite') {
      const expr = expressionProblem(
        (def as { expression: string }).expression,
        info.code.trim(),
      );
      if (expr) throw new BadRequestException(tr(expr));
    }
  }

  protected payloadOf(info: MetricUpsertInfo): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      kind: info.kind,
      code: info.code.trim(),
      name: info.name.trim(),
      definition: info.definition,
      enabled: info.enabled ?? true,
    };
    if (info.aliases?.length) {
      payload.aliases = info.aliases.map((a) => a.trim()).filter(Boolean);
    }
    if (info.description?.trim()) payload.description = info.description.trim();
    if (info.unit?.trim()) payload.unit = info.unit.trim();
    return payload;
  }

  protected infoFromPayload(payload: unknown): MetricUpsertInfo {
    if (payload == null || typeof payload !== 'object') {
      throw new BadRequestException(tr('metric.invalid_payload'));
    }
    const p = payload as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const kind = str(p.kind) as MetricKind;
    if (!METRIC_KINDS.includes(kind)) {
      throw new BadRequestException(tr('metric.invalid_payload'));
    }
    return {
      kind,
      scope: 'WORKSPACE', // placeholder — review() supplies the real target
      code: str(p.code),
      name: str(p.name),
      aliases: Array.isArray(p.aliases)
        ? p.aliases.filter((a): a is string => typeof a === 'string')
        : undefined,
      description:
        typeof p.description === 'string' ? p.description : undefined,
      unit: typeof p.unit === 'string' ? p.unit : undefined,
      definition:
        p.definition && typeof p.definition === 'object'
          ? (p.definition as Record<string, unknown>)
          : {},
      enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    };
  }

  protected infoOfRow(
    row: GovernedRow & Record<string, unknown>,
  ): MetricUpsertInfo {
    return {
      kind: row.kind as MetricKind,
      scope: row.scope as SemanticScope,
      code: row.code as string,
      name: row.name as string,
      definition: (row.definition ?? {}) as Record<string, unknown>,
      enabled: false,
    };
  }

  protected naturalKeyOf(info: MetricUpsertInfo): Record<string, unknown> {
    return { kind: info.kind, code: info.code.trim() };
  }

  protected async applyUpsertTx(
    tx: PrismaTx,
    info: MetricUpsertInfo,
    target: MetricTarget,
    changedBy: number,
    note?: string,
  ): Promise<number> {
    const data = {
      name: info.name.trim(),
      aliases: (info.aliases?.map((a) => a.trim()).filter(Boolean) ??
        undefined) as Prisma.InputJsonValue,
      description: info.description?.trim() || null,
      unit: info.unit?.trim() || null,
      definition: info.definition as Prisma.InputJsonValue,
      enabled: info.enabled ?? true,
    };
    const existing = await tx.metricDef.findFirst({
      where: {
        scope: target.scope,
        oid: target.oid,
        ownerUid: target.ownerUid,
        kind: info.kind,
        code: info.code.trim(),
      },
    });
    if (existing) {
      const updated = await tx.metricDef.update({
        where: { id: existing.id },
        data: { ...data, version: { increment: 1 } },
      });
      await tx.metricDefVersion.create({
        data: {
          entityId: updated.id,
          version: updated.version,
          snapshot: { ...data, source: 'edit' },
          changedBy,
          note: note ?? null,
        },
      });
      return updated.id;
    }
    const created = await tx.metricDef.create({
      data: {
        ...target,
        kind: info.kind,
        code: info.code.trim(),
        ...data,
        createBy: changedBy,
      },
    });
    await tx.metricDefVersion.create({
      data: {
        entityId: created.id,
        version: 1,
        snapshot: { ...data, source: 'create' },
        changedBy,
        note: note ?? null,
      },
    });
    return created.id;
  }

  protected async applyRemoveTx(
    tx: PrismaTx,
    info: MetricUpsertInfo,
    target: MetricTarget,
  ): Promise<void> {
    const row = await tx.metricDef.findFirst({
      where: {
        scope: target.scope,
        oid: target.oid,
        ownerUid: target.ownerUid,
        kind: info.kind,
        code: info.code.trim(),
      },
    });
    if (row) await tx.metricDef.delete({ where: { id: row.id } });
  }

  protected async loadRows(
    ids: number[],
  ): Promise<Array<GovernedRow & Record<string, unknown>>> {
    if (ids.length === 0) return [];
    return this.prisma.metricDef.findMany({ where: { id: { in: ids } } });
  }

  protected async loadRow(id: number): Promise<GovernedRow | null> {
    return this.prisma.metricDef.findUnique({ where: { id } });
  }

  protected async deleteRowTx(tx: PrismaTx, id: number): Promise<void> {
    await tx.metricDef.delete({ where: { id } });
  }

  protected async setEnabledTx(
    tx: PrismaTx,
    id: number,
    enabled: boolean,
    changedBy: number,
  ): Promise<void> {
    const updated = await tx.metricDef.update({
      where: { id },
      data: { enabled, version: { increment: 1 } },
    });
    await tx.metricDefVersion.create({
      data: {
        entityId: id,
        version: updated.version,
        snapshot: {
          kind: updated.kind,
          code: updated.code,
          name: updated.name,
          aliases: updated.aliases,
          description: updated.description,
          unit: updated.unit,
          definition: updated.definition,
          enabled,
          source: 'toggle',
        },
        changedBy,
        note: null,
      },
    });
  }
}
