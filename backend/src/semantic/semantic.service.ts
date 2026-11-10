// SemanticService — the M2 effective-semantics layer: per-table / per-field
// business meanings with three scope layers (GLOBAL / WORKSPACE / PERSONAL,
// priority PERSONAL > WORKSPACE > GLOBAL, see semantic-policy.ts), append-only
// version history, and the cross-layer approval flow (a member's edit to an
// upper layer becomes a SemanticChangeRequest the layer's admin approves
// before a version lands).
//
// Natural keys (datasourceId + tableName [+ fieldName]) — deliberately NOT
// Table/Field FKs so a schema re-sync that recreates table rows never
// orphans semantics. Scope uniqueness is enforced by the partial unique
// indexes from migration 20261110130000_semantic_natural_key_unique; a
// concurrent create race is retried once in a fresh transaction.
//
// Known limitation: deleting an entity cascades its version history away;
// the deletion itself is still audited by the @SystemLog interceptor.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import { DatasourceService } from '../datasource/datasource.service';
import {
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from '../common/config/embedding-config';
import {
  canEditDirect,
  canReview,
  scopeOwnership,
  pickEffectiveRow,
  isSystemAdmin,
  FIELD_ROLES,
  SEMANTIC_SCOPES,
  type FieldRole,
  type SemanticActor,
  type SemanticScope,
} from './semantic-policy';
import { withNaturalKeyRetry } from './natural-key';
import {
  toFieldSemanticSnake,
  toRequestSnake,
  toTableSemanticSnake,
  toVersionSnake,
  type SemanticEntitySnake,
  type SemanticPage,
  type SemanticRequestPage,
  type SemanticVersionSnake,
} from './semantic-snake-mapper';

export type EntityType = 'table' | 'field';

/** Upsert input (wire shape — snake keys validated by the DTO). */
export interface SemanticUpsertInfo {
  entity_type: EntityType;
  scope: SemanticScope;
  datasource_id: number;
  table_name: string;
  field_name?: string;
  role?: FieldRole;
  meaning: string;
  unit?: string;
  enum_values?: Array<{ value: string; label?: string }>;
  enabled?: boolean;
  note?: string;
}

export type SemanticUpsertResult =
  { applied: true; id: number } | { applied: false; request_id: number };

/** One dimension field handled by an enum-collection run (snake wire). */
export interface EnumCollectItem {
  id: number;
  table_name: string;
  field_name: string;
}

/** collectEnums response: backfilled rows with their cached value count +
 *  skipped rows with the human-readable reason (i18n'd server-side). */
export interface EnumCollectSummary {
  collected: Array<EnumCollectItem & { values: number }>;
  skipped: Array<EnumCollectItem & { reason: string }>;
}

/** Normalize one sampled cell into an enum value string; objects/arrays and
 *  empty text carry no enum semantics and drop out (nulls included — a NULL
 *  is not a dimension member). */
function enumValueText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  switch (typeof v) {
    case 'string':
      return v.trim() || null;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    default:
      return null;
  }
}

/** A cached dimension member as stored in FieldSemantic.enumValues. */
interface SemanticEnumEntry {
  value: string;
  /** Business-facing name; absent for values collected without one. */
  label?: string;
}

/** Defensive parse of the stored enumValues JSON into {value,label?} entries
 *  (malformed/legacy items are dropped instead of breaking the prompt). */
function enumEntries(raw: unknown): SemanticEnumEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SemanticEnumEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const { value, label } = item as { value?: unknown; label?: unknown };
    if (typeof value !== 'string' || value.trim() === '') continue;
    const entry: SemanticEnumEntry = { value };
    if (typeof label === 'string' && label.trim() !== '') {
      entry.label = label.trim();
    }
    out.push(entry);
  }
  return out;
}

/** value → label map from a stored enumValues blob (label-less entries are
 *  skipped); used by collectEnums to keep curated labels across re-samples. */
function enumLabelMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of enumEntries(raw)) {
    if (e.label) map.set(e.value, e.label);
  }
  return map;
}

/** The effective annotations the SQL prompt consumes (M2.2 rule 2). */
export interface SemanticAnnotations {
  /** tableName → resolved business meaning (only tables WITH a semantic). */
  tableMeanings: Record<string, string>;
  /** `${tableName}.${fieldName}` → role-tagged note for the M-Schema lines. */
  fieldNotes: Record<
    string,
    {
      role: FieldRole;
      meaning: string;
      unit?: string;
      /** Cached dimension members; `label` is the business-facing name. */
      enums?: Array<{ value: string; label?: string }>;
    }
  >;
}

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class SemanticService {
  constructor(
    private readonly prisma: PrismaService,
    // Connector access for the M3.3 enum collector (bounded DISTINCT probes).
    private readonly datasourceService: DatasourceService,
  ) {}

  private actor(): SemanticActor & { account: string } {
    const user = RequestContext.getUser();
    if (!user) {
      throw new ForbiddenException(tr('semantic.no_context_user'));
    }
    return {
      id: user.id,
      oid: user.oid,
      weight: user.weight,
      account: user.account,
    };
  }

  // ---- read: admin page -----------------------------------------------

  /** Paginated entity list, visible layers only: GLOBAL (everyone) +
   *  WORKSPACE (own workspace) + PERSONAL (own rows). `table_exists` /
   *  `field_exists` flags dangling semantics (natural-key tables deleted or
   *  renamed in the source DB). */
  async page(
    entityType: EntityType,
    currentPage: number,
    pageSize: number,
    filters?: { scope?: string; datasourceId?: number; keyword?: string },
  ): Promise<SemanticPage<SemanticEntitySnake>> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    // Keyword narrows WITHIN the visible layers — the visibility OR stays a
    // separate AND clause (overwriting it would leak other workspaces' rows
    // through a keyword search; found while building the M4 metric page on
    // the same pattern).
    const andClauses: Prisma.TableSemanticWhereInput[] = [
      {
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: actor.oid },
          { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
        ],
      },
    ];
    if (filters?.keyword?.trim()) {
      const kw = filters.keyword.trim();
      andClauses.push({
        OR: [
          { tableName: { contains: kw, mode: 'insensitive' } },
          { meaning: { contains: kw, mode: 'insensitive' } },
        ],
      });
    }
    const visible: Prisma.TableSemanticWhereInput = { AND: andClauses };
    if (filters?.scope && SEMANTIC_SCOPES.includes(filters.scope as never)) {
      visible.scope = filters.scope;
    }
    if (filters?.datasourceId) visible.datasourceId = filters.datasourceId;

    const isTable = entityType === 'table';
    const rows = isTable
      ? await this.prisma.tableSemantic.findMany({
          where: visible,
          orderBy: [{ datasourceId: 'asc' }, { tableName: 'asc' }],
        })
      : await this.prisma.fieldSemantic.findMany({
          where: visible as Prisma.FieldSemanticWhereInput,
          orderBy: [{ datasourceId: 'asc' }, { tableName: 'asc' }],
        });
    const total_count = rows.length;
    const total_pages = total_count > 0 ? Math.ceil(total_count / ps) : 0;
    const cpClamped = total_pages > 0 ? Math.min(cp, total_pages) : 1;
    const start = (cpClamped - 1) * ps;
    const pageRows = (rows as Record<string, unknown>[]).slice(
      start,
      start + ps,
    );

    // Dangling check: which natural keys still exist as synced Table rows?
    const dsIds = [...new Set(pageRows.map((r) => r.datasourceId as number))];
    const nameByDs = new Map<number, Set<string>>();
    for (const dsId of dsIds) {
      const tables = await this.prisma.table.findMany({
        where: { datasourceId: dsId },
        select: { tableName: true },
      });
      nameByDs.set(dsId, new Set(tables.map((t) => t.tableName)));
    }

    const data: SemanticEntitySnake[] = pageRows.map((r) => {
      const exists =
        nameByDs.get(r.datasourceId as number)?.has(r.tableName as string) ??
        false;
      return isTable
        ? toTableSemanticSnake(r as never, exists)
        : toFieldSemanticSnake(r as never, exists);
    });
    return {
      current_page: cpClamped,
      page_size: ps,
      total_count,
      total_pages,
      data,
    };
  }

  /** Version history of one entity (newest first). */
  async versions(
    entityType: EntityType,
    id: number,
  ): Promise<SemanticVersionSnake[]> {
    const rows = (await (entityType === 'table'
      ? this.prisma.tableSemanticVersion.findMany({
          where: { entityId: id },
          orderBy: { version: 'desc' },
        })
      : this.prisma.fieldSemanticVersion.findMany({
          where: { entityId: id },
          orderBy: { version: 'desc' },
        }))) as never[];
    return rows.map((r) => toVersionSnake(r));
  }

  // ---- write: upsert / remove / enable --------------------------------

  /** Upsert one semantic. Direct edit when the actor owns the target layer's
   *  authority; otherwise a pending SemanticChangeRequest (the layer's admin
   *  applies it on approval). The version history row is written in the SAME
   *  transaction as the entity write. */
  async upsert(info: SemanticUpsertInfo): Promise<SemanticUpsertResult> {
    const actor = this.actor();
    this.validateInfo(info);
    const target = scopeOwnership(actor, info.scope);
    if (!target) throw new BadRequestException(tr('semantic.invalid_scope'));

    if (canEditDirect(actor, info.scope)) {
      const id = await withNaturalKeyRetry(
        () =>
          this.prisma.$transaction((tx) =>
            this.applyUpsertTx(tx, info, target, actor.id, info.note),
          ),
        () => new ConflictException(tr('semantic.write_conflict')),
      );
      return { applied: true, id };
    }
    // Lower layer proposing to an upper layer → approval queue.
    const requestId = await this.prisma.$transaction(async (tx) => {
      await this.assertNoPendingRequest(tx, info, 'upsert');
      const request = await tx.semanticChangeRequest.create({
        data: {
          oid: actor.oid,
          entityType: info.entity_type,
          action: 'upsert',
          targetType: info.scope,
          payload: this.payloadOf(info) as unknown as Prisma.InputJsonValue,
          proposerUid: actor.id,
          proposer: actor.account,
        },
      });
      return request.id;
    });
    return { applied: false, request_id: requestId };
  }

  /** Remove entities by id. Rows the actor may edit directly are deleted;
   *  upper-layer rows become `remove` requests. Returns both counts. */
  async remove(
    entityType: EntityType,
    ids: number[],
  ): Promise<{ removed: number; requested: number }> {
    const actor = this.actor();
    const rows = (await (entityType === 'table'
      ? this.prisma.tableSemantic.findMany({ where: { id: { in: ids } } })
      : this.prisma.fieldSemantic.findMany({
          where: { id: { in: ids } },
        }))) as Array<{
      id: number;
      scope: string;
      oid: number | null;
      datasourceId: number;
      tableName: string;
      fieldName?: string;
    }>;
    if (rows.length === 0) {
      throw new NotFoundException(tr('semantic.entity_not_found'));
    }
    let removed = 0;
    let requested = 0;
    for (const row of rows) {
      const scope = row.scope as SemanticScope;
      if (canEditDirect(actor, scope) && this.ownsRow(actor, row)) {
        await this.prisma.$transaction(async (tx) => {
          if (entityType === 'table') {
            await tx.tableSemantic.delete({ where: { id: row.id } });
          } else {
            await tx.fieldSemantic.delete({ where: { id: row.id } });
          }
        });
        removed += 1;
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const info = this.infoOfRow(entityType, row, scope, { meaning: '' });
        await this.assertNoPendingRequest(tx, info, 'remove');
        await tx.semanticChangeRequest.create({
          data: {
            oid: actor.oid,
            entityType,
            action: 'remove',
            targetType: scope,
            payload: this.payloadOf(info) as unknown as Prisma.InputJsonValue,
            proposerUid: actor.id,
            proposer: actor.account,
          },
        });
      });
      requested += 1;
    }
    return { removed, requested };
  }

  /** Enable/disable toggle — edit authority on the row's own scope. */
  async setEnabled(
    entityType: EntityType,
    id: number,
    enabled: boolean,
  ): Promise<void> {
    const actor = this.actor();
    const row = await this.loadEntity(entityType, id);
    const scope = row.scope as SemanticScope;
    if (!canEditDirect(actor, scope) || !this.ownsRow(actor, row)) {
      throw new ForbiddenException(tr('semantic.edit_forbidden'));
    }
    await this.prisma.$transaction(async (tx) => {
      if (entityType === 'table') {
        await tx.tableSemantic.update({
          where: { id },
          data: { enabled, version: { increment: 1 } },
        });
      } else {
        await tx.fieldSemantic.update({
          where: { id },
          data: { enabled, version: { increment: 1 } },
        });
      }
      await this.writeVersion(tx, entityType, id, enabled, actor.id, null);
    });
  }

  // ---- approval flow ---------------------------------------------------

  /** `pending` = requests the actor can review (workspace admin → WORKSPACE
   *  target of their workspace; system admin → everything pending);
   *  `mine` = the actor's own proposals. entityType stays table|field here —
   *  the M4 metric/standard dictionaries have their own inbox on the shared
   *  table (GovernedDictService.pageRequests). */
  async pageRequests(
    box: 'pending' | 'mine',
    currentPage: number,
    pageSize: number,
  ): Promise<SemanticRequestPage> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    const base: Prisma.SemanticChangeRequestWhereInput = {
      entityType: { in: ['table', 'field'] },
    };
    const where: Prisma.SemanticChangeRequestWhereInput =
      box === 'mine'
        ? { ...base, proposerUid: actor.id }
        : isSystemAdmin(actor)
          ? { ...base, status: 'pending' }
          : {
              ...base,
              status: 'pending',
              targetType: 'WORKSPACE',
              oid: actor.oid,
            };
    const rows = await this.prisma.semanticChangeRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const total_count = rows.length;
    const total_pages = total_count > 0 ? Math.ceil(total_count / ps) : 0;
    const cpClamped = total_pages > 0 ? Math.min(cp, total_pages) : 1;
    const start = (cpClamped - 1) * ps;
    return {
      current_page: cpClamped,
      page_size: ps,
      total_count,
      total_pages,
      data: rows.slice(start, start + ps).map(toRequestSnake),
    };
  }

  /** Approve / reject a request. Approval applies the payload at the target
   *  layer in ONE transaction (upsert/remove + version history + close). */
  async review(
    id: number,
    approve: boolean,
    reviewNote?: string,
  ): Promise<void> {
    const actor = this.actor();
    const request = await this.prisma.semanticChangeRequest.findUnique({
      where: { id },
    });
    if (!request || request.status !== 'pending') {
      throw new BadRequestException(tr('semantic.request_not_pending'));
    }
    if (!canReview(actor, request.targetType as SemanticScope)) {
      throw new ForbiddenException(tr('semantic.review_forbidden'));
    }
    // A WORKSPACE-target request is bound to the proposer's workspace; the
    // reviewer must administer THAT workspace (uid 1 passes, a foreign
    // workspace admin does not).
    if (
      request.targetType === 'WORKSPACE' &&
      !isSystemAdmin(actor) &&
      request.oid !== actor.oid
    ) {
      throw new ForbiddenException(tr('semantic.review_forbidden'));
    }
    await withNaturalKeyRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          if (approve) {
            const info = this.infoFromPayload(request.payload);
            const target =
              request.targetType === 'WORKSPACE'
                ? {
                    scope: 'WORKSPACE' as const,
                    oid: request.oid,
                    ownerUid: null,
                  }
                : {
                    scope: 'GLOBAL' as const,
                    oid: null,
                    ownerUid: null,
                  };
            if (request.action === 'upsert') {
              await this.applyUpsertTx(tx, info, target, actor.id, reviewNote);
            } else {
              await this.applyRemoveTx(tx, info.entity_type, target, info);
            }
          }
          await tx.semanticChangeRequest.update({
            where: { id },
            data: {
              status: approve ? 'approved' : 'rejected',
              reviewerUid: actor.id,
              reviewNote: reviewNote ?? null,
              reviewedAt: new Date(),
            },
          });
        }),
      () => new ConflictException(tr('semantic.write_conflict')),
    );
  }

  // ---- effective resolution (prompt integration) ------------------------

  /** Resolve the actor-effective semantics for the given tables: per natural
   *  key pick PERSONAL > WORKSPACE > GLOBAL among enabled rows. Returns only
   *  keys that HAVE a semantic (absent keys simply stay out — the M-Schema
   *  falls back to comments). */
  async effectiveAnnotations(
    datasourceId: number,
    tableNames: string[],
  ): Promise<SemanticAnnotations> {
    const actor = this.actor();
    const names = [...new Set(tableNames.filter((n) => n && n.trim()))];
    if (names.length === 0) {
      return { tableMeanings: {}, fieldNotes: {} };
    }
    const visible = {
      datasourceId,
      tableName: { in: names },
      enabled: true,
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'WORKSPACE', oid: actor.oid },
        { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
      ],
    };
    const [tables, fields] = await Promise.all([
      this.prisma.tableSemantic.findMany({
        where: visible,
      }),
      this.prisma.fieldSemantic.findMany({
        where: visible,
      }),
    ]);
    const tableMeanings: Record<string, string> = {};
    // group per key then pick per priority
    const byTable = new Map<string, typeof tables>();
    for (const t of tables) {
      const list = byTable.get(t.tableName) ?? [];
      list.push(t);
      byTable.set(t.tableName, list);
    }
    for (const [name, list] of byTable) {
      const effective = pickEffectiveRow(list);
      if (effective) tableMeanings[name] = effective.meaning;
    }
    const fieldNotes: SemanticAnnotations['fieldNotes'] = {};
    const byField = new Map<string, typeof fields>();
    for (const f of fields) {
      const key = `${f.tableName}.${f.fieldName}`;
      const list = byField.get(key) ?? [];
      list.push(f);
      byField.set(key, list);
    }
    for (const [key, list] of byField) {
      const effective = pickEffectiveRow(list);
      if (!effective) continue;
      const enums = enumEntries(effective.enumValues).slice(0, 20);
      fieldNotes[key] = {
        role: effective.role as FieldRole,
        meaning: effective.meaning,
        unit: effective.unit ?? undefined,
        enums: enums.length > 0 ? enums : undefined,
      };
    }
    return { tableMeanings, fieldNotes };
  }

  // ---- internals --------------------------------------------------------

  private validateInfo(info: SemanticUpsertInfo): void {
    if (!SEMANTIC_SCOPES.includes(info.scope)) {
      throw new BadRequestException(tr('semantic.invalid_scope'));
    }
    if (!info.table_name?.trim() || !info.meaning?.trim()) {
      throw new BadRequestException(tr('semantic.missing_fields'));
    }
    if (info.entity_type === 'field') {
      if (!info.field_name?.trim()) {
        throw new BadRequestException(tr('semantic.missing_fields'));
      }
      if (info.role && !FIELD_ROLES.includes(info.role)) {
        throw new BadRequestException(tr('semantic.invalid_role'));
      }
    }
  }

  /** PERSONAL rows are always the actor's own (a user can never address
   *  someone else's personal layer, even though canEditDirect allows the
   *  scope as a whole). */
  private ownsRow(
    actor: SemanticActor,
    row: { scope: string; oid: number | null; ownerUid?: number | null },
  ): boolean {
    if (row.scope === 'PERSONAL') {
      return row.oid === actor.oid && row.ownerUid === actor.id;
    }
    if (row.scope === 'WORKSPACE') return row.oid === actor.oid;
    return true; // GLOBAL — authority already checked by canEditDirect
  }

  private async loadEntity(
    entityType: EntityType,
    id: number,
  ): Promise<{
    id: number;
    scope: string;
    oid: number | null;
    ownerUid: number | null;
  }> {
    const row = (await (entityType === 'table'
      ? this.prisma.tableSemantic.findUnique({ where: { id } })
      : this.prisma.fieldSemantic.findUnique({ where: { id } }))) as {
      id: number;
      scope: string;
      oid: number | null;
      ownerUid: number | null;
    } | null;
    if (!row) throw new NotFoundException(tr('semantic.entity_not_found'));
    return row;
  }

  /** The natural-key + content payload persisted on a request (scope-free —
   *  the target scope lives on the request row itself). */
  private payloadOf(info: SemanticUpsertInfo): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      datasource_id: info.datasource_id,
      table_name: info.table_name.trim(),
      meaning: info.meaning.trim(),
      enabled: info.enabled ?? true,
    };
    if (info.entity_type === 'field') {
      payload.field_name = info.field_name!.trim();
      payload.role = info.role ?? 'other';
      if (info.unit?.trim()) payload.unit = info.unit.trim();
      if (info.enum_values?.length) payload.enum_values = info.enum_values;
    }
    return payload;
  }

  private infoFromPayload(payload: unknown): SemanticUpsertInfo {
    if (payload == null || typeof payload !== 'object') {
      throw new BadRequestException(tr('semantic.invalid_payload'));
    }
    const p = payload as Record<string, unknown>;
    const entityType =
      p.field_name !== undefined ? ('field' as const) : ('table' as const);
    // String-cast guards: a hand-corrupted payload must not stringify an
    // object into '[object Object]'.
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      entity_type: entityType,
      scope: 'WORKSPACE', // placeholder — review() supplies the real target
      datasource_id: Number(p.datasource_id),
      table_name: str(p.table_name),
      field_name: p.field_name !== undefined ? str(p.field_name) : undefined,
      role: typeof p.role === 'string' ? (p.role as FieldRole) : undefined,
      meaning: str(p.meaning),
      unit: typeof p.unit === 'string' ? p.unit : undefined,
      enum_values: Array.isArray(p.enum_values)
        ? (p.enum_values as SemanticUpsertInfo['enum_values'])
        : undefined,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    };
  }

  private infoOfRow(
    entityType: EntityType,
    row: {
      datasourceId: number;
      tableName: string;
      fieldName?: string;
    },
    scope: SemanticScope,
    content: { meaning: string },
  ): SemanticUpsertInfo {
    return {
      entity_type: entityType,
      scope,
      datasource_id: row.datasourceId,
      table_name: row.tableName,
      field_name: row.fieldName,
      meaning: content.meaning,
      enabled: false,
    };
  }

  private async assertNoPendingRequest(
    tx: PrismaTx,
    info: SemanticUpsertInfo,
    action: 'upsert' | 'remove',
  ): Promise<void> {
    const existing = await tx.semanticChangeRequest.findFirst({
      where: {
        status: 'pending',
        action,
        targetType: info.scope,
        proposerUid: this.actor().id,
      },
    });
    if (!existing) return;
    const p = existing.payload as Record<string, unknown>;
    if (
      Number(p.datasource_id) === info.datasource_id &&
      p.table_name === info.table_name.trim() &&
      p.field_name === (info.field_name?.trim() ?? undefined)
    ) {
      throw new BadRequestException(tr('semantic.request_pending_exists'));
    }
  }

  /** Create-or-update + version-history write, inside the caller's tx. */
  private async applyUpsertTx(
    tx: PrismaTx,
    info: SemanticUpsertInfo,
    target: {
      scope: SemanticScope;
      oid: number | null;
      ownerUid: number | null;
    },
    changedBy: number,
    note?: string,
  ): Promise<number> {
    if (info.entity_type === 'table') {
      const existing = await tx.tableSemantic.findFirst({
        where: {
          scope: target.scope,
          oid: target.oid,
          ownerUid: target.ownerUid,
          datasourceId: info.datasource_id,
          tableName: info.table_name.trim(),
        },
      });
      const data = {
        meaning: info.meaning.trim(),
        enabled: info.enabled ?? true,
      };
      if (existing) {
        const updated = await tx.tableSemantic.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        });
        await tx.tableSemanticVersion.create({
          data: {
            entityId: updated.id,
            version: updated.version,
            snapshot: {
              ...data,
              source: 'edit',
            },
            changedBy,
            note: note ?? null,
          },
        });
        return updated.id;
      }
      const created = await tx.tableSemantic.create({
        data: {
          ...target,
          datasourceId: info.datasource_id,
          tableName: info.table_name.trim(),
          ...data,
          createBy: changedBy,
        },
      });
      await tx.tableSemanticVersion.create({
        data: {
          entityId: created.id,
          version: 1,
          snapshot: {
            ...data,
            source: 'create',
          },
          changedBy,
          note: note ?? null,
        },
      });
      return created.id;
    }
    // field
    const existing = await tx.fieldSemantic.findFirst({
      where: {
        scope: target.scope,
        oid: target.oid,
        ownerUid: target.ownerUid,
        datasourceId: info.datasource_id,
        tableName: info.table_name.trim(),
        fieldName: info.field_name!.trim(),
      },
    });
    const data = {
      role: info.role ?? 'other',
      meaning: info.meaning.trim(),
      unit: info.unit?.trim() || null,
      enumValues: (info.enum_values ?? undefined) as Prisma.InputJsonValue,
      enabled: info.enabled ?? true,
    };
    if (existing) {
      const updated = await tx.fieldSemantic.update({
        where: { id: existing.id },
        data: { ...data, version: { increment: 1 } },
      });
      await tx.fieldSemanticVersion.create({
        data: {
          entityId: updated.id,
          version: updated.version,
          snapshot: {
            ...data,
            source: 'edit',
          },
          changedBy,
          note: note ?? null,
        },
      });
      return updated.id;
    }
    const created = await tx.fieldSemantic.create({
      data: {
        ...target,
        datasourceId: info.datasource_id,
        tableName: info.table_name.trim(),
        fieldName: info.field_name!.trim(),
        ...data,
        createBy: changedBy,
      },
    });
    await tx.fieldSemanticVersion.create({
      data: {
        entityId: created.id,
        version: 1,
        snapshot: {
          ...data,
          source: 'create',
        },
        changedBy,
        note: note ?? null,
      },
    });
    return created.id;
  }

  /** Remove at the target layer (approval of a `remove` request). Deletes the
   *  matching row if present; a no-match is tolerated (idempotent close). */
  private async applyRemoveTx(
    tx: PrismaTx,
    entityType: EntityType,
    target: {
      scope: SemanticScope;
      oid: number | null;
      ownerUid: number | null;
    },
    info: SemanticUpsertInfo,
  ): Promise<void> {
    const where = {
      scope: target.scope,
      oid: target.oid,
      ownerUid: target.ownerUid,
      datasourceId: info.datasource_id,
      tableName: info.table_name.trim(),
      ...(entityType === 'field' ? { fieldName: info.field_name!.trim() } : {}),
    };
    if (entityType === 'table') {
      const row = await tx.tableSemantic.findFirst({
        where: where,
      });
      if (row) await tx.tableSemantic.delete({ where: { id: row.id } });
    } else {
      const row = await tx.fieldSemantic.findFirst({
        where: where,
      });
      if (row) await tx.fieldSemantic.delete({ where: { id: row.id } });
    }
  }

  /** Version snapshot after an enable/disable toggle (content fields are read
   *  back from the updated row). */
  private async writeVersion(
    tx: PrismaTx,
    entityType: EntityType,
    entityId: number,
    enabled: boolean,
    changedBy: number,
    note: string | null,
  ): Promise<void> {
    if (entityType === 'table') {
      const row = await tx.tableSemantic.findUnique({
        where: { id: entityId },
      });
      if (!row) return;
      await tx.tableSemanticVersion.create({
        data: {
          entityId,
          version: row.version,
          snapshot: {
            meaning: row.meaning,
            enabled,
            source: 'toggle',
          },
          changedBy,
          note,
        },
      });
    } else {
      const row = await tx.fieldSemantic.findUnique({
        where: { id: entityId },
      });
      if (!row) return;
      await tx.fieldSemanticVersion.create({
        data: {
          entityId,
          version: row.version,
          snapshot: {
            role: row.role,
            meaning: row.meaning,
            unit: row.unit,
            enabled,
            source: 'toggle',
          },
          changedBy,
          note,
        },
      });
    }
  }

  // ---- dimension-enum collection (MetaDataImprove M3.3) ------------------

  /** Per-datasource run bookkeeping for the enum collector: cooldownUntil
   *  enforces the configured rerun rate limit, busyRuns collapses concurrent
   *  double-clicks. In-memory only — this deployment is single-node. */
  private readonly enumCooldownUntil = new Map<number, number>();
  private readonly busyEnumRuns = new Set<number>();

  /** One enum-collection run over a datasource's dimension fields: every
   *  visible enabled FieldSemantic with role=dimension gets a bounded
   *  DISTINCT sample (`semantic.enum_scan_rows`); fields whose distinct
   *  count stays under `semantic.enum_max_values` are low-cardinality and
   *  their enumValues cache is backfilled as a versioned edit
   *  (source: 'enum_collect'). Everything else is skipped with a reason —
   *  the response reports both, one bad field never aborts the batch.
   *
   *  Authority follows M2 governance: only rows the actor can edit directly
   *  are touched (upper-layer rows keep their approval round).
   *
   *  Known limitation: values are sampled from the first N rows, so a
   *  dimension whose rare values live deeper in the table may cache an
   *  incomplete enum — re-running after data growth refreshes it. Labels
   *  already attached to still-sampled values survive the refresh; new
   *  values start without one. */
  async collectEnums(datasourceId: number): Promise<EnumCollectSummary> {
    const actor = this.actor();
    const cfg = await resolveEmbeddingConfig(this.prisma);
    const now = Date.now();
    const cooldownUntil = this.enumCooldownUntil.get(datasourceId) ?? 0;
    if (now < cooldownUntil) {
      throw new BadRequestException(
        tr('semantic.enum_cooldown_active', {
          seconds: Math.ceil((cooldownUntil - now) / 1000),
        }),
      );
    }
    if (this.busyEnumRuns.has(datasourceId)) {
      throw new BadRequestException(
        tr('semantic.enum_cooldown_active', {
          seconds: cfg.semanticEnumCooldown,
        }),
      );
    }
    this.busyEnumRuns.add(datasourceId);
    try {
      const summary = await this.runEnumCollection(datasourceId, actor, cfg);
      // arm the rate limit only after a (possibly partial) successful run
      this.enumCooldownUntil.set(
        datasourceId,
        Date.now() + cfg.semanticEnumCooldown * 1000,
      );
      return summary;
    } finally {
      this.busyEnumRuns.delete(datasourceId);
    }
  }

  private async runEnumCollection(
    datasourceId: number,
    actor: SemanticActor,
    cfg: EmbeddingConfig,
  ): Promise<EnumCollectSummary> {
    // findOne is oid-scoped — a foreign datasource id 404s before any probe.
    const ds = await this.datasourceService.findOne(datasourceId);
    const fieldsByTable = new Map(
      ds.tables.map((t) => [
        t.tableName,
        new Set(t.fields.map((f) => f.fieldName)),
      ]),
    );
    const rows = await this.prisma.fieldSemantic.findMany({
      where: {
        datasourceId,
        role: 'dimension',
        enabled: true,
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: actor.oid },
          { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
        ],
      },
      orderBy: [{ tableName: 'asc' }, { fieldName: 'asc' }],
    });

    const item = (row: {
      id: number;
      tableName: string;
      fieldName: string;
    }) => ({
      id: row.id,
      table_name: row.tableName,
      field_name: row.fieldName,
    });
    const collected: EnumCollectSummary['collected'] = [];
    const skipped: EnumCollectSummary['skipped'] = [];
    const eligible: typeof rows = [];
    for (const row of rows) {
      if (!canEditDirect(actor, row.scope as SemanticScope)) {
        skipped.push({
          ...item(row),
          reason: tr('semantic.enum_no_authority'),
        });
        continue;
      }
      const tableFields = fieldsByTable.get(row.tableName);
      if (!tableFields) {
        skipped.push({
          ...item(row),
          reason: tr('semantic.enum_table_missing'),
        });
        continue;
      }
      if (!tableFields.has(row.fieldName)) {
        skipped.push({
          ...item(row),
          reason: tr('semantic.enum_field_missing'),
        });
        continue;
      }
      eligible.push(row);
    }

    if (eligible.length > 0) {
      // One connector session for the whole batch; probes run sequentially
      // (the in-run throttle — no parallel DISTINCT storm on the source DB).
      await this.datasourceService.withConnection(datasourceId, async (c) => {
        for (const row of eligible) {
          let raw: unknown[];
          try {
            raw = await c.sampleDistinct(
              row.tableName,
              row.fieldName,
              cfg.semanticEnumScanRows,
            );
          } catch (e) {
            skipped.push({
              ...item(row),
              reason: tr('semantic.enum_query_failed', {
                reason: e instanceof Error ? e.message : String(e),
              }),
            });
            continue;
          }
          const distinct = [
            ...new Set(raw.map(enumValueText).filter((v): v is string => !!v)),
          ].sort();
          if (distinct.length > cfg.semanticEnumMaxValues) {
            skipped.push({
              ...item(row),
              reason: tr('semantic.enum_high_cardinality', {
                max: cfg.semanticEnumMaxValues,
              }),
            });
            continue;
          }
          // Keep curated labels for values that still appear; new values start
          // label-less. Values no longer sampled are dropped by the existing
          // whole-cache overwrite (the cache mirrors this sample).
          const priorLabels = enumLabelMap(row.enumValues);
          const enumValues = distinct.map((value) => {
            const label = priorLabels.get(value);
            return label ? { value, label } : { value };
          });
          await this.prisma.$transaction(async (tx) => {
            const updated = await tx.fieldSemantic.update({
              where: { id: row.id },
              data: {
                enumValues: enumValues,
                version: { increment: 1 },
              },
            });
            await tx.fieldSemanticVersion.create({
              data: {
                entityId: row.id,
                version: updated.version,
                snapshot: {
                  role: updated.role,
                  meaning: updated.meaning,
                  unit: updated.unit,
                  enumValues: updated.enumValues,
                  enabled: updated.enabled,
                  source: 'enum_collect',
                },
                changedBy: actor.id,
              },
            });
          });
          collected.push({ ...item(row), values: distinct.length });
        }
      });
    }
    return { collected, skipped };
  }
}
