// Shared import/export helpers — 2026-09 review P3-3. terminology.service
// and custom-prompt.service copy-pasted these five helpers verbatim (destined
// to drift); they now live here once. Pure functions + a prisma client param
// (no DI) so both services and their specs reuse the same implementations.
import type { PrismaService } from '../../database/prisma.service';

/** ExcelJS cell value → plain string. Handles richText arrays, formula
 *  results ({result: ...}), bare text/number/boolean cells; null-safe. */
export function cellText(value: unknown): string {
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

/** Row shape shared by the ds/adv list filters (Terminology + CustomPrompt
 *  both structurally satisfy it — Json datasourceIds, stringified assistant
 *  id in advancedApplication). */
export interface DsAdvRow {
  specificDs: boolean;
  datasourceIds: unknown;
  advancedApplication: string | null;
}

/** Post-fetch ds_list/adv_list filtering: ds filter matches rows that are
 *  global (specificDs=false) or scoped to one of the listed datasources; adv
 *  filter matches rows bound to one of the listed advanced applications
 *  (stringified ids). */
export function applyDsAdvFilters<T extends DsAdvRow>(
  rows: T[],
  dsList: number[] = [],
  advList: number[] = [],
): T[] {
  let filtered = rows;
  if (dsList.length > 0) {
    filtered = filtered.filter(
      (r) =>
        !r.specificDs ||
        (Array.isArray(r.datasourceIds) &&
          (r.datasourceIds as number[]).some((id) => dsList.includes(id))),
    );
  }
  if (advList.length > 0) {
    const advSet = new Set(advList.map(String));
    filtered = filtered.filter(
      (r) => r.advancedApplication != null && advSet.has(r.advancedApplication),
    );
  }
  return filtered;
}

/** datasource id → name map for a page of rows (one findMany, not N+1). */
export async function buildDatasourceNamesMap(
  prisma: PrismaService,
  rows: { datasourceIds: unknown }[],
  oid?: number,
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  for (const r of rows) {
    if (Array.isArray(r.datasourceIds)) {
      for (const id of r.datasourceIds as number[]) ids.add(id);
    }
  }
  if (ids.size === 0) return new Map();
  const found = await prisma.datasource.findMany({
    where: {
      id: { in: Array.from(ids) },
      ...(oid !== undefined ? { oid } : {}),
    },
    select: { id: true, name: true },
  });
  return new Map(found.map((r) => [r.id, r.name]));
}

/** assistant id → name map for a page of rows (stringified ids, one
 *  findMany). */
export async function buildAdvancedAppNamesMap(
  prisma: PrismaService,
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
  const found = await prisma.assistant.findMany({
    where: { id: { in: Array.from(ids) } },
    select: { id: true, name: true },
  });
  return new Map(found.map((r) => [r.id, r.name]));
}

/** datasource name → id map (import resolution, one findMany). */
export async function buildDatasourceNameToIdMap(
  prisma: PrismaService,
  oid?: number,
): Promise<Map<string, number>> {
  const rows = await prisma.datasource.findMany({
    where: oid !== undefined ? { oid } : {},
    select: { id: true, name: true },
  });
  // First-wins within a workspace; duplicate names across workspaces can no
  // longer resolve to a foreign datasource when oid is supplied.
  return new Map(rows.map((r) => [r.name.trim(), r.id]));
}

/** workspace-scoped assistant name → id map (import resolution). */
export async function buildAssistantNameToIdMap(
  prisma: PrismaService,
  oid: number,
): Promise<Map<string, number>> {
  const rows = await prisma.assistant.findMany({
    where: { oid },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.name.trim(), r.id]));
}
