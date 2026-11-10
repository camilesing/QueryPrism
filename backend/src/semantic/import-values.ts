// Shared value parsing for the semantic / metric / standard ingestion paths
// (MetaDataImprove): import rows may carry `scope` + `enabled`; Excel columns
// are appended after the historical layout so old workbooks keep working
// (missing cell → WORKSPACE / enabled).
import { SEMANTIC_SCOPES, type SemanticScope } from './semantic-policy';

export interface ImportFailure {
  row: string;
  reason: string;
}

/** Additive import reply: `applied` stays the direct-write count, and
 *  `by_scope` lets the admin UI show where each row landed. */
export interface ImportSummary {
  applied: number;
  by_scope: Record<SemanticScope, number>;
  failed: ImportFailure[];
}

export function emptyScopeCounts(): Record<SemanticScope, number> {
  return { GLOBAL: 0, WORKSPACE: 0, PERSONAL: 0 };
}

/** Empty/absent → WORKSPACE (backward-compatible default); unknown → null
 *  so the caller can fail that row without aborting the batch. */
export function parseImportScope(raw: unknown): SemanticScope | null {
  if (raw == null) return 'WORKSPACE';
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toUpperCase();
  if (!text) return 'WORKSPACE';
  return SEMANTIC_SCOPES.includes(text as SemanticScope)
    ? (text as SemanticScope)
    : null;
}

/** Excel users commonly type FALSE/0; everything else (including absent) is
 *  enabled, matching the pre-existing metric/standard import behavior. */
export function parseImportEnabled(raw: unknown): boolean {
  if (raw === false || raw === 0) return false;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    return text !== 'false' && text !== '0';
  }
  return true;
}

/** Excel import combines the metric and standard sub-batches into one reply. */
export function mergeImportSummaries(
  first: ImportSummary,
  second: ImportSummary,
): ImportSummary {
  return {
    applied: first.applied + second.applied,
    by_scope: {
      GLOBAL: first.by_scope.GLOBAL + second.by_scope.GLOBAL,
      WORKSPACE: first.by_scope.WORKSPACE + second.by_scope.WORKSPACE,
      PERSONAL: first.by_scope.PERSONAL + second.by_scope.PERSONAL,
    },
    failed: [...first.failed, ...second.failed],
  };
}
