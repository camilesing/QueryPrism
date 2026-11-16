// governed-dict.service — the M2 governance flow (direct edit vs proposal,
// remove, request inbox, review) extracted for the M4 metric + data-standard
// dictionaries so they reuse it verbatim instead of growing parallel copies.
// SemanticService keeps its own concrete implementation — its M2 surface is
// stable and deliberately not refactored onto this base.
//
// Subclasses own the entity-specific halves: prisma delegate access,
// validation, wire<->payload mapping, the apply-tx writes (entity + version
// snapshot in ONE transaction) and page/versions listing. The change-request
// queue itself is shared: SemanticChangeRequest with entityType
// 'metric' | 'standard', i18n keys under the <entityType>.* namespace.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import {
  canEditDirect,
  canReview,
  isSystemAdmin,
  scopeOwnership,
  SEMANTIC_SCOPES,
  type SemanticActor,
  type SemanticScope,
} from './semantic-policy';
import { withNaturalKeyRetry } from './natural-key';
import { RegressionTriggerService } from '../regression/regression-trigger.service';
import {
  toRequestSnake,
  type SemanticPage,
  type SemanticRequestSnake,
} from './semantic-snake-mapper';

export type PrismaTx = Parameters<
  Parameters<PrismaService['$transaction']>[0]
>[0];

/** The shared governance columns every governed dictionary row carries. */
export interface GovernedRow {
  id: number;
  scope: string;
  oid: number | null;
  ownerUid: number | null;
  enabled: boolean;
  version: number;
}

/** The upsert-info contract subclasses satisfy (wire-shaped). */
export interface GovernedInfo {
  scope: SemanticScope;
  enabled?: boolean;
  note?: string;
}

export type GovernedUpsertResult =
  { applied: true; id: number } | { applied: false; request_id: number };

@Injectable()
export abstract class GovernedDictService<Info extends GovernedInfo> {
  protected constructor(
    protected readonly prisma: PrismaService,
    private readonly regressionTrigger: RegressionTriggerService,
  ) {}

  /** SemanticChangeRequest entityType + i18n namespace of this dictionary. */
  protected abstract readonly entityType: 'metric' | 'standard';

  /** i18n through this dictionary's namespace (metric.* / standard.*). */
  protected t(key: string): string {
    return tr(`${this.entityType}.${key}`);
  }

  protected actor(): SemanticActor & { account: string } {
    const user = RequestContext.getUser();
    if (!user) {
      throw new ForbiddenException(this.t('no_context_user'));
    }
    return {
      id: user.id,
      oid: user.oid,
      weight: user.weight,
      account: user.account,
    };
  }

  /** The actor-visible layer filter (GLOBAL + own workspace + own personal).
   *  Deliberately a plain structural type — Prisma's per-model WhereInput
   *  generics don't unify across MetricDef/DataStandard. */
  protected visibleFilter(actor: SemanticActor): {
    OR: Array<{ scope: string; oid?: number; ownerUid?: number }>;
  } {
    return {
      OR: [
        { scope: 'GLOBAL' },
        { scope: 'WORKSPACE', oid: actor.oid },
        { scope: 'PERSONAL', oid: actor.oid, ownerUid: actor.id },
      ],
    };
  }

  // ---- abstract entity hooks -------------------------------------------

  protected abstract validateInfo(info: Info): void;

  /** Entity-specific write guard run before direct/proposal routing. Metric
   *  overrides it to reject a datasource binding the actor's workspace does
   *  not own; the default has nothing to check. */
  protected async assertWriteAllowed(_info: Info): Promise<void> {}

  /** The natural-key + content payload persisted on a change request
   *  (scope-free — the target scope lives on the request row). */
  protected abstract payloadOf(info: Info): Record<string, unknown>;

  protected abstract infoFromPayload(payload: unknown): Info;

  /** Rebuild an identifying Info from a stored row (remove-request payload). */
  protected abstract infoOfRow(
    row: GovernedRow & Record<string, unknown>,
  ): Info;

  /** The natural-key projection compared against pending payloads for the
   *  one-pending-proposal-per-key dedupe (keys must match payloadOf's). */
  protected abstract naturalKeyOf(info: Info): Record<string, unknown>;

  /** Create-or-update + version-history write, inside the caller's tx.
   *  Returns the entity id. */
  protected abstract applyUpsertTx(
    tx: PrismaTx,
    info: Info,
    target: {
      scope: SemanticScope;
      oid: number | null;
      ownerUid: number | null;
    },
    changedBy: number,
    note?: string,
  ): Promise<number>;

  /** Remove at the target layer (approval of a `remove` request) — idempotent. */
  protected abstract applyRemoveTx(
    tx: PrismaTx,
    info: Info,
    target: {
      scope: SemanticScope;
      oid: number | null;
      ownerUid: number | null;
    },
  ): Promise<void>;

  protected abstract loadRows(
    ids: number[],
  ): Promise<Array<GovernedRow & Record<string, unknown>>>;

  protected abstract loadRow(id: number): Promise<GovernedRow | null>;

  /** Load a row the actor may SEE (GLOBAL / own WORKSPACE / own PERSONAL).
   *  Read endpoints (version history) must go through this: `loadRow` is a
   *  bare id lookup and the id space is shared across workspaces. */
  protected async loadVisibleRow(id: number): Promise<GovernedRow> {
    const actor = this.actor();
    const row = await this.loadRow(id);
    if (!row || !this.ownsRow(actor, row)) {
      throw new NotFoundException(this.t('entity_not_found'));
    }
    return row;
  }

  protected abstract deleteRowTx(tx: PrismaTx, id: number): Promise<void>;

  /** Enable/disable + version snapshot, inside one tx (entity-specific data). */
  protected abstract setEnabledTx(
    tx: PrismaTx,
    id: number,
    enabled: boolean,
    changedBy: number,
  ): Promise<void>;

  /** Called AFTER a governance write committed, with the affected entity ids.
   *  Overridden by dictionaries that maintain a derived search index (metric
   *  vector recall); the default is a no-op (data standards have none). It must
   *  be synchronous and swallow its own errors — a search-index refresh must
   *  never fail or roll back a governance write. Remove paths pass no ids:
   *  a stale vector row is harmless because recall re-reads the entity and
   *  drops ids that no longer exist. */
  protected afterCommit(_ids: number[]): void {}

  // ---- the shared governance flow ---------------------------------------

  /** Upsert one entry. Direct edit when the actor owns the target layer's
   *  authority; otherwise a pending SemanticChangeRequest the layer's admin
   *  applies on approval. */
  async upsert(info: Info): Promise<GovernedUpsertResult> {
    const actor = this.actor();
    this.assertScope(info.scope);
    this.validateInfo(info);
    await this.assertWriteAllowed(info);
    const target = scopeOwnership(actor, info.scope);
    if (!target) throw new BadRequestException(this.t('invalid_scope'));

    if (canEditDirect(actor, info.scope)) {
      const id = await withNaturalKeyRetry(
        () =>
          this.prisma.$transaction((tx) =>
            this.applyUpsertTx(tx, info, target, actor.id, info.note),
          ),
        () => new ConflictException(this.t('write_conflict')),
      );
      this.afterCommit([id]);
      return { applied: true, id };
    }
    const requestId = await this.prisma.$transaction(async (tx) => {
      await this.assertNoPendingRequest(tx, info, 'upsert');
      const request = await tx.semanticChangeRequest.create({
        data: {
          oid: actor.oid,
          entityType: this.entityType,
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

  /** Remove entries by id — direct rows vanish, upper-layer rows become
   *  `remove` requests. Returns both counts. */
  async remove(ids: number[]): Promise<{ removed: number; requested: number }> {
    const actor = this.actor();
    // Ids are global auto-increment values: never load rows the actor cannot
    // see. A partial hit (some foreign ids) rejects the whole request before
    // any write, so a caller cannot probe other tenants' ids through the
    // returned counts or the approval inbox.
    const requestedIds = [...new Set(ids.filter((n) => Number.isInteger(n)))];
    const rows = (await this.loadRows(requestedIds)).filter((row) =>
      this.ownsRow(actor, row),
    );
    if (requestedIds.length === 0 || rows.length !== requestedIds.length) {
      throw new NotFoundException(this.t('entity_not_found'));
    }
    let removed = 0;
    let requested = 0;
    for (const row of rows) {
      if (
        canEditDirect(actor, row.scope as SemanticScope) &&
        this.ownsRow(actor, row)
      ) {
        await this.prisma.$transaction((tx) => this.deleteRowTx(tx, row.id));
        removed += 1;
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const info = this.infoOfRow(row);
        await this.assertNoPendingRequest(tx, info, 'remove');
        await tx.semanticChangeRequest.create({
          data: {
            oid: actor.oid,
            entityType: this.entityType,
            action: 'remove',
            targetType: info.scope,
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
  async setEnabled(id: number, enabled: boolean): Promise<void> {
    const actor = this.actor();
    const row = await this.loadRow(id);
    if (!row) throw new NotFoundException(this.t('entity_not_found'));
    const scope = row.scope as SemanticScope;
    if (!canEditDirect(actor, scope) || !this.ownsRow(actor, row)) {
      throw new ForbiddenException(this.t('edit_forbidden'));
    }
    await this.prisma.$transaction((tx) =>
      this.setEnabledTx(tx, id, enabled, actor.id),
    );
    // An enabled row with no vector (it was disabled while the index was
    // built, or the key was missing) must become recallable again.
    this.afterCommit([id]);
  }

  /** The approval inbox. `pending` = requests the actor can review (workspace
   *  admin → WORKSPACE target of their workspace; system admin → everything);
   *  `mine` = the actor's own proposals. */
  async pageRequests(
    box: 'pending' | 'mine',
    currentPage: number,
    pageSize: number,
    entityTypes: string[] = [this.entityType],
  ): Promise<SemanticPage<SemanticRequestSnake>> {
    const actor = this.actor();
    const cp = currentPage > 0 ? Math.floor(currentPage) : 1;
    const ps = Math.max(10, Math.floor(pageSize));
    const base: Prisma.SemanticChangeRequestWhereInput = {
      entityType: { in: entityTypes },
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
   *  layer in ONE transaction (claim + upsert/remove + version history).
   *  Concurrency: the status read above happens outside the transaction, so
   *  two reviewers can both see `pending`. The conditional claim inside the
   *  transaction is the real guard — only one `updateMany` matches
   *  `status='pending'`; the loser waits on the row lock and then matches 0
   *  rows (PostgreSQL re-checks the WHERE against the newest row version), so
   *  the request is applied exactly once and the second call gets the same
   *  "not pending" error as a repeat click. A payload failure rolls the claim
   *  back with the rest of the transaction, leaving the request reviewable. */
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
      throw new BadRequestException(this.t('request_not_pending'));
    }
    // targetType is the request's layer; anything outside WORKSPACE/GLOBAL is
    // malformed (a PERSONAL-target request must never be coerced to GLOBAL).
    if (request.targetType !== 'WORKSPACE' && request.targetType !== 'GLOBAL') {
      throw new BadRequestException(this.t('invalid_scope'));
    }
    if (!canReview(actor, request.targetType)) {
      throw new ForbiddenException(this.t('review_forbidden'));
    }
    // A WORKSPACE-target request is bound to the proposer's workspace; the
    // reviewer must administer THAT workspace (uid 1 passes, a foreign
    // workspace admin does not).
    if (
      request.targetType === 'WORKSPACE' &&
      !isSystemAdmin(actor) &&
      request.oid !== actor.oid
    ) {
      throw new ForbiddenException(this.t('review_forbidden'));
    }
    let affected: number[] = [];
    await withNaturalKeyRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          affected = [];
          const claimed = await tx.semanticChangeRequest.updateMany({
            where: { id, status: 'pending' },
            data: {
              status: approve ? 'approved' : 'rejected',
              reviewerUid: actor.id,
              reviewNote: reviewNote ?? null,
              reviewedAt: new Date(),
            },
          });
          if (claimed.count === 0) {
            throw new BadRequestException(this.t('request_not_pending'));
          }
          if (!approve) return;
          const info = this.infoFromPayload(request.payload);
          const target =
            request.targetType === 'WORKSPACE'
              ? {
                  scope: 'WORKSPACE' as const,
                  oid: request.oid,
                  ownerUid: null,
                }
              : { scope: 'GLOBAL' as const, oid: null, ownerUid: null };
          if (request.action === 'upsert') {
            affected = [
              await this.applyUpsertTx(tx, info, target, actor.id, reviewNote),
            ];
          } else {
            await this.applyRemoveTx(tx, info, target);
          }
        }),
      () => new ConflictException(this.t('write_conflict')),
    );
    this.afterCommit(affected);
    // MetaDataImprove M6: an approved change just moved the semantic layer —
    // schedule a debounced regression run (fire-and-forget; the approval
    // transaction must never depend on the suite). A GLOBAL change runs in
    // the proposer's workspace (request.oid), the only one whose cases can
    // reference it so far.
    if (approve) {
      this.regressionTrigger.onApproval(
        request.oid ?? actor.oid,
        this.entityType,
        { request_id: id, action: request.action },
      );
    }
  }

  // ---- internals ---------------------------------------------------------

  protected assertScope(scope: string): void {
    if (!SEMANTIC_SCOPES.includes(scope as never)) {
      throw new BadRequestException(this.t('invalid_scope'));
    }
  }

  /** PERSONAL rows are always the actor's own; WORKSPACE rows belong to the
   *  actor's workspace; GLOBAL authority was checked by canEditDirect. */
  protected ownsRow(
    actor: SemanticActor,
    row: { scope: string; oid: number | null; ownerUid?: number | null },
  ): boolean {
    if (row.scope === 'PERSONAL') {
      return row.oid === actor.oid && row.ownerUid === actor.id;
    }
    if (row.scope === 'WORKSPACE') return row.oid === actor.oid;
    return true;
  }

  /** Best-effort duplicate-proposal probe: it scans ONE pending request of the
   *  actor and compares its natural key. Two truly concurrent proposals can
   *  both miss each other (the other's row is not committed yet), so duplicates
   *  are possible; that is accepted — approval applies the surviving payloads
   *  in order (last one wins) and never creates a duplicate entity, because the
   *  natural key is unique per layer. A DB constraint is not worth the
   *  non-null/expression-index migration cost here. */
  private async assertNoPendingRequest(
    tx: PrismaTx,
    info: Info,
    action: 'upsert' | 'remove',
  ): Promise<void> {
    const existing = await tx.semanticChangeRequest.findFirst({
      where: {
        status: 'pending',
        action,
        entityType: this.entityType,
        targetType: info.scope,
        proposerUid: this.actor().id,
      },
    });
    if (!existing) return;
    const p = existing.payload as Record<string, unknown>;
    const key = this.naturalKeyOf(info);
    const same = Object.entries(key).every(
      ([k, v]) => p[k] === v || String(p[k]) === String(v),
    );
    if (same) {
      throw new BadRequestException(this.t('request_pending_exists'));
    }
  }
}
