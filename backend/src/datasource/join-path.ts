// Join-topology derivation over the FK edge graph (MetaDataImprove M3).
//
// The relation editor's edges form an undirected join graph (an FK reads
// both ways in SQL). When the recall pre-filter or the semantic rule-2
// narrowing stuffs only a subset of tables, a question spanning two of them
// may need the CONNECTING table between them — without it the LLM has to
// hallucinate the join. `joinBridgeTables` finds those connectors via BFS
// ≤2 hops:  seedA — mid — seedB  (mid not itself a seed).
//
// Pure and DB-free (sibling of table-recall.ts) so the topology rules are
// unit-testable in isolation; the chat pipeline owns the pruning decisions.

import type { TableRelationEdge } from './m-schema.builder';

/** table → set of adjacent tables (edges are undirected for joins). */
function adjacency(edges: TableRelationEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adj.get(a) ?? new Set<string>();
    set.add(b);
    adj.set(a, set);
  };
  for (const e of edges) {
    if (!e.fromTable || !e.toTable || e.fromTable === e.toTable) continue;
    link(e.fromTable, e.toTable);
    link(e.toTable, e.fromTable);
  }
  return adj;
}

/** Intermediate tables that connect two DIFFERENT seed tables within 2 hops
 *  (seedA — mid — seedB). A mid that only hangs off ONE seed is not a bridge
 *  — it is just another candidate for recall, not join topology.
 *
 *  `universe` (when given) restricts the result to known tables — the chat
 *  pipeline passes the datasource's checked tables so an unchecked (hidden)
 *  or dangling name never enters the schema. Sorted for determinism. */
export function joinBridgeTables(
  edges: TableRelationEdge[],
  seeds: Array<string | undefined>,
  universe?: Iterable<string>,
): string[] {
  const seedSet = new Set(
    seeds.filter((s): s is string => typeof s === 'string' && s.trim() !== ''),
  );
  if (seedSet.size < 2) return [];
  const adj = adjacency(edges);

  const bridges = new Set<string>();
  for (const [mid, neighbors] of adj) {
    if (seedSet.has(mid)) continue;
    let seedNeighbors = 0;
    for (const n of neighbors) {
      if (seedSet.has(n)) seedNeighbors++;
      // two distinct seeds adjacent to mid = a connecting path exists
      if (seedNeighbors >= 2) break;
    }
    if (seedNeighbors >= 2) bridges.add(mid);
  }
  let out = [...bridges];
  if (universe) {
    const allowed = new Set(universe);
    out = out.filter((b) => allowed.has(b));
  }
  return out.sort();
}
