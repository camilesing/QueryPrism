// DataStandardService — the M4 data-standards dictionary (units of measure +
// naming dictionary) on the shared governed-dictionary governance: three
// scope layers, append-only version history, cross-layer approval
// (SemanticChangeRequest entityType 'standard').
//
// Runtime role: naming entries matched by the question text render the
// <naming_rules> prompt block (namingTemplateFor). The unit dictionary is
// advisory — it feeds management/autocomplete and never validates existing
// free-text unit strings (FieldSemantic.unit, MetricDef.unit).
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { tr } from '../common/i18n/translate';
import type { SemanticScope } from './semantic-policy';
import {
  NAMING_CATEGORIES,
  STANDARD_KINDS,
  UNIT_CATEGORIES,
  namingTemplate,
  type StandardKind,
} from './metric-policy';
import {
  GovernedDictService,
  type GovernedRow,
  type PrismaTx,
} from './governed-dict.service';
import {
  toDataStandardSnake,
  type DataStandardSnake,
} from './metric-snake-mapper';
import {
  toVersionSnake,
  type SemanticPage,
  type SemanticVersionSnake,
} from './semantic-snake-mapper';
import { RegressionTriggerService } from '../regression/regression-trigger.service';

export interface StandardUpsertInfo {
  kind: StandardKind;
  scope: SemanticScope;
  code: string;
  term: string;
  name: string;
  aliases?: string[];
  category?: string;
  description?: string;
  enabled?: boolean;
  note?: string;
}

type StandardTarget = {
  scope: SemanticScope;
  oid: number | null;
  ownerUid: number | null;
};

@Injectable()
export class DataStandardService extends GovernedDictService<StandardUpsertInfo> {
  protected readonly entityType = 'standard' as const;

  constructor(
    prisma: PrismaService,
    regressionTrigger: RegressionTriggerService,
  ) {
    super(prisma, regressionTrigger);
  }

  // ---- read: admin page ---------------------------------------------------

  /** Paginated list of one kind (unit | naming), visible layers only. */
  async page(
    kind: StandardKind,
    currentPage: number,
    pageSize: number,
    filters?: { scope?: string; category?: string; keyword?: string },
  ): Promise<SemanticPage<DataStandardSnake>> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    // Keyword narrows WITHIN the visible layers (see semantic.page).
    const andClauses: Prisma.DataStandardWhereInput[] = [
      this.visibleFilter(actor),
    ];
    if (filters?.keyword?.trim()) {
      const kw = filters.keyword.trim();
      andClauses.push({
        OR: [
          { code: { contains: kw, mode: 'insensitive' } },
          { term: { contains: kw, mode: 'insensitive' } },
          { name: { contains: kw, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.DataStandardWhereInput = { kind, AND: andClauses };
    if (filters?.scope) where.scope = filters.scope;
    if (filters?.category) where.category = filters.category;
    const rows = await this.prisma.dataStandard.findMany({
      where,
      orderBy: [{ code: 'asc' }],
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
      data: rows.slice(start, start + ps).map(toDataStandardSnake),
    };
  }

  /** Version history of one entry (newest first). Visibility is checked first —
   *  entity ids are global, so a bare id lookup would leak other workspaces'. */
  async versions(id: number): Promise<SemanticVersionSnake[]> {
    await this.loadVisibleRow(id);
    const rows = await this.prisma.dataStandardVersion.findMany({
      where: { entityId: id },
      orderBy: { version: 'desc' },
    });
    return rows.map((r) => toVersionSnake(r as never));
  }

  // ---- runtime: prompt integration ----------------------------------------

  /** The <naming_rules> prompt block for a question ('' when nothing
   *  matched). Injected by the chat pipeline when naming.enabled is on. */
  async namingTemplateFor(question: string, max: number): Promise<string> {
    if (!question.trim()) return '';
    const actor = this.actor();
    const rows = await this.prisma.dataStandard.findMany({
      where: {
        kind: 'naming',
        enabled: true,
        ...this.visibleFilter(actor),
      },
    });
    return namingTemplate(rows, question, max);
  }

  // ---- governance hooks -----------------------------------------------------

  protected validateInfo(info: StandardUpsertInfo): void {
    if (!STANDARD_KINDS.includes(info.kind)) {
      throw new BadRequestException(this.t('invalid_kind'));
    }
    if (!info.code?.trim()) {
      throw new BadRequestException(this.t('missing_fields'));
    }
    if (!info.term?.trim() || !info.name?.trim()) {
      throw new BadRequestException(this.t('missing_fields'));
    }
    if (info.category) {
      const allowed =
        info.kind === 'unit' ? UNIT_CATEGORIES : NAMING_CATEGORIES;
      if (!allowed.includes(info.category as never)) {
        throw new BadRequestException(tr('standard.invalid_category'));
      }
    }
  }

  protected payloadOf(info: StandardUpsertInfo): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      kind: info.kind,
      code: info.code.trim(),
      term: info.term.trim(),
      name: info.name.trim(),
      enabled: info.enabled ?? true,
    };
    if (info.aliases?.length) {
      payload.aliases = info.aliases.map((a) => a.trim()).filter(Boolean);
    }
    if (info.category?.trim()) payload.category = info.category.trim();
    if (info.description?.trim()) payload.description = info.description.trim();
    return payload;
  }

  protected infoFromPayload(payload: unknown): StandardUpsertInfo {
    if (payload == null || typeof payload !== 'object') {
      throw new BadRequestException(tr('standard.invalid_payload'));
    }
    const p = payload as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const kind = str(p.kind) as StandardKind;
    if (!STANDARD_KINDS.includes(kind)) {
      throw new BadRequestException(tr('standard.invalid_payload'));
    }
    return {
      kind,
      scope: 'WORKSPACE', // placeholder — review() supplies the real target
      code: str(p.code),
      term: str(p.term),
      name: str(p.name),
      aliases: Array.isArray(p.aliases)
        ? p.aliases.filter((a): a is string => typeof a === 'string')
        : undefined,
      category: typeof p.category === 'string' ? p.category : undefined,
      description:
        typeof p.description === 'string' ? p.description : undefined,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    };
  }

  protected infoOfRow(
    row: GovernedRow & Record<string, unknown>,
  ): StandardUpsertInfo {
    return {
      kind: row.kind as StandardKind,
      scope: row.scope as SemanticScope,
      code: row.code as string,
      term: row.term as string,
      name: row.name as string,
      category: (row.category as string | null) ?? undefined,
      description: (row.description as string | null) ?? undefined,
      enabled: false,
    };
  }

  protected naturalKeyOf(info: StandardUpsertInfo): Record<string, unknown> {
    return { kind: info.kind, code: info.code.trim() };
  }

  protected async applyUpsertTx(
    tx: PrismaTx,
    info: StandardUpsertInfo,
    target: StandardTarget,
    changedBy: number,
    note?: string,
  ): Promise<number> {
    const data = {
      term: info.term.trim(),
      name: info.name.trim(),
      aliases: (info.aliases?.map((a) => a.trim()).filter(Boolean) ??
        undefined) as Prisma.InputJsonValue,
      category: info.category?.trim() || null,
      description: info.description?.trim() || null,
      enabled: info.enabled ?? true,
    };
    const existing = await tx.dataStandard.findFirst({
      where: {
        scope: target.scope,
        oid: target.oid,
        ownerUid: target.ownerUid,
        kind: info.kind,
        code: info.code.trim(),
      },
    });
    if (existing) {
      const updated = await tx.dataStandard.update({
        where: { id: existing.id },
        data: { ...data, version: { increment: 1 } },
      });
      await tx.dataStandardVersion.create({
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
    const created = await tx.dataStandard.create({
      data: {
        ...target,
        kind: info.kind,
        code: info.code.trim(),
        ...data,
        createBy: changedBy,
      },
    });
    await tx.dataStandardVersion.create({
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
    info: StandardUpsertInfo,
    target: StandardTarget,
  ): Promise<void> {
    const row = await tx.dataStandard.findFirst({
      where: {
        scope: target.scope,
        oid: target.oid,
        ownerUid: target.ownerUid,
        kind: info.kind,
        code: info.code.trim(),
      },
    });
    if (row) await tx.dataStandard.delete({ where: { id: row.id } });
  }

  protected async loadRows(
    ids: number[],
  ): Promise<Array<GovernedRow & Record<string, unknown>>> {
    if (ids.length === 0) return [];
    return this.prisma.dataStandard.findMany({ where: { id: { in: ids } } });
  }

  protected async loadRow(id: number): Promise<GovernedRow | null> {
    return this.prisma.dataStandard.findUnique({ where: { id } });
  }

  protected async deleteRowTx(tx: PrismaTx, id: number): Promise<void> {
    await tx.dataStandard.delete({ where: { id } });
  }

  protected async setEnabledTx(
    tx: PrismaTx,
    id: number,
    enabled: boolean,
    changedBy: number,
  ): Promise<void> {
    const updated = await tx.dataStandard.update({
      where: { id },
      data: { enabled, version: { increment: 1 } },
    });
    await tx.dataStandardVersion.create({
      data: {
        entityId: id,
        version: updated.version,
        snapshot: {
          kind: updated.kind,
          code: updated.code,
          term: updated.term,
          name: updated.name,
          aliases: updated.aliases,
          category: updated.category,
          description: updated.description,
          enabled,
          source: 'toggle',
        },
        changedBy,
        note: null,
      },
    });
  }
}
