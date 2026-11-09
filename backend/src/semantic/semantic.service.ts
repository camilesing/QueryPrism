// SemanticService — the M2 effective-semantics layer: per-table / per-field
// business meanings with three scope layers (GLOBAL / WORKSPACE / PERSONAL,
// priority PERSONAL > WORKSPACE > GLOBAL, see semantic-policy.ts), append-only
// version history, and the cross-layer approval flow (a member's edit to an
// upper layer becomes a SemanticChangeRequest the layer's admin approves
// before a version lands).
//
// Natural keys (datasourceId + tableName [+ fieldName]) — deliberately NOT
// Table/Field FKs so a schema re-sync that recreates table rows never
// orphans semantics. Scope uniqueness is enforced inside the write
// transaction (Prisma cannot express conditional unique indexes).
//
// Known limitation: deleting an entity cascades its version history away;
// the deletion itself is still audited by the @SystemLog interceptor.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
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
  | { applied: true; id: number }
  | { applied: false; request_id: number };

/** The effective annotations the SQL prompt consumes (M2.2 rule 2). */
export interface SemanticAnnotations {
  /** tableName → resolved business meaning (only tables WITH a semantic). */
  tableMeanings: Record<string, string>;
  /** `${tableName}.${fieldName}` → role-tagged note for the M-Schema lines. */
  fieldNotes: Record<
    string,
    { role: FieldRole; meaning: string; unit?: string; enums?: string[] }
  >;
}

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class SemanticService {
  constructor(private readonly prisma: PrismaService) {}

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
    const visible: Prisma.TableSemanticWhereInput = {
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'WORKSPACE', oid: actor.oid },
        { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
      ],
    };
    if (filters?.scope && SEMANTIC_SCOPES.includes(filters.scope as never)) {
      visible.scope = filters.scope;
    }
    if (filters?.datasourceId) visible.datasourceId = filters.datasourceId;
    if (filters?.keyword?.trim()) {
      const kw = filters.keyword.trim();
      visible.OR = [
        { tableName: { contains: kw, mode: 'insensitive' } },
        { meaning: { contains: kw, mode: 'insensitive' } },
      ];
    }

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
      const id = await this.prisma.$transaction((tx) =>
        this.applyUpsertTx(tx, info, target, actor.id, info.note),
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
   *  `mine` = the actor's own proposals. */
  async pageRequests(
    box: 'pending' | 'mine',
    currentPage: number,
    pageSize: number,
  ): Promise<SemanticRequestPage> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    const where: Prisma.SemanticChangeRequestWhereInput =
      box === 'mine'
        ? { proposerUid: actor.id }
        : isSystemAdmin(actor)
          ? { status: 'pending' }
          : { status: 'pending', targetType: 'WORKSPACE', oid: actor.oid };
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
    await this.prisma.$transaction(async (tx) => {
      if (approve) {
        const info = this.infoFromPayload(request.payload);
        const target =
          request.targetType === 'WORKSPACE'
            ? { scope: 'WORKSPACE' as const, oid: request.oid, ownerUid: null }
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
    });
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
      const enums = Array.isArray(effective.enumValues)
        ? (effective.enumValues as Array<{ value?: unknown }>)
            .map((e) => (typeof e?.value === 'string' ? e.value : ''))
            .filter((v) => v !== '')
            .slice(0, 20)
        : undefined;
      fieldNotes[key] = {
        role: effective.role as FieldRole,
        meaning: effective.meaning,
        unit: effective.unit ?? undefined,
        enums: enums && enums.length > 0 ? enums : undefined,
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
}
