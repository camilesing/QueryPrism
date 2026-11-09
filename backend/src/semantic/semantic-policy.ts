// Semantic-layer pure policy (MetaDataImprove M2): scope authority checks +
// the PERSONAL > WORKSPACE > GLOBAL resolution priority. Pure (no Nest/Prisma)
// so the layering rules are unit-testable in isolation — the service owns all
// persistence.

export const SEMANTIC_SCOPES = ['GLOBAL', 'WORKSPACE', 'PERSONAL'] as const;
export type SemanticScope = (typeof SEMANTIC_SCOPES)[number];

export const FIELD_ROLES = ['metric', 'dimension', 'time', 'other'] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];

/** The actor as the policy sees it (mirrors CurrentUserInfo's auth fields). */
export interface SemanticActor {
  id: number;
  oid: number;
  /** Workspace weight: 0 = normal member, != 0 = workspace admin. */
  weight?: number;
}

/** uid 1 is the system admin (mirror AdminGuard / WsAdminGuard). */
export const ADMIN_UID = 1;

export function isSystemAdmin(actor: SemanticActor): boolean {
  return actor.id === ADMIN_UID;
}

export function isWorkspaceAdmin(actor: SemanticActor): boolean {
  return isSystemAdmin(actor) || (actor.weight ?? 0) !== 0;
}

/** Who may edit a scope layer DIRECTLY (without an approval round):
 *  - PERSONAL: anyone, but only their own rows (the service forces
 *    ownerUid = actor.id; you can never touch another user's personal layer)
 *  - WORKSPACE: the workspace admin (or system admin)
 *  - GLOBAL: only the system admin (uid 1)
 *  Everyone else proposes via SemanticChangeRequest. */
export function canEditDirect(
  actor: SemanticActor,
  scope: SemanticScope,
): boolean {
  if (scope === 'PERSONAL') return true;
  if (scope === 'WORKSPACE') return isWorkspaceAdmin(actor);
  return isSystemAdmin(actor);
}

/** Who may REVIEW a change request targeting a layer:
 *  - WORKSPACE target: the proposer's workspace admins
 *  - GLOBAL target: only the system admin */
export function canReview(
  actor: SemanticActor,
  targetType: SemanticScope,
): boolean {
  if (targetType === 'WORKSPACE') return isWorkspaceAdmin(actor);
  return isSystemAdmin(actor);
}

/** The row shape the priority resolution picks between (one row per layer). */
export interface ScopedRow {
  scope: string;
  oid: number | null;
  ownerUid: number | null;
}

const priorityOf = (scope: string): number =>
  scope === 'PERSONAL'
    ? 3
    : scope === 'WORKSPACE'
      ? 2
      : scope === 'GLOBAL'
        ? 1
        : 0;

/** Resolve the effective row for one natural key from the candidate rows the
 *  caller loaded (already filtered to actor-visible). Priority
 *  PERSONAL > WORKSPACE > GLOBAL; missing layers simply fall through. Ties
 *  (should not happen — scope uniqueness is enforced on write) resolve to the
 *  newest updatedAt. */
export function pickEffectiveRow<T extends { scope: string }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  const updatedOf = (r: T): string => {
    const u = (r as { updatedAt?: unknown }).updatedAt;
    if (u instanceof Date) return u.toISOString();
    return typeof u === 'string' ? u : '';
  };
  const sorted = [...rows].sort(
    (a, b) =>
      priorityOf(b.scope) - priorityOf(a.scope) ||
      updatedOf(b).localeCompare(updatedOf(a)),
  );
  return sorted[0];
}

/** Normalize scope ownership fields for a write: PERSONAL rows always belong
 *  to the actor's own workspace + uid; WORKSPACE rows to the actor's
 *  workspace; GLOBAL rows carry no owner. Returns null for an unknown scope. */
export function scopeOwnership(
  actor: SemanticActor,
  scope: SemanticScope,
): {
  scope: SemanticScope;
  oid: number | null;
  ownerUid: number | null;
} | null {
  if (scope === 'PERSONAL') {
    return { scope, oid: actor.oid, ownerUid: actor.id };
  }
  if (scope === 'WORKSPACE') {
    return { scope, oid: actor.oid, ownerUid: null };
  }
  if (scope === 'GLOBAL') {
    return { scope, oid: null, ownerUid: null };
  }
  return null;
}
