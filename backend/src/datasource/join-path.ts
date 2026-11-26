// Join-topology derivation over the FK edge graph (MetaDataImprove M3).
//
// The relation editor's edges form an undirected join graph (an FK reads
// both ways in SQL). When the recall pre-filter or the semantic rule-2
// narrowing stuffs only a subset of tables, a question spanning two of them
// may need the CONNECTING table(s) between them — without them the LLM has to
// hallucinate the join. `joinBridgeTables` finds those connectors via BFS up
// to `maxHops` hops (runtime parameter `join.bridge_max_hops`, default 2):
//   maxHops = 2 → seedA — mid — seedB
//   maxHops = 3 → seedA — midA — midB — seedB  (both mids are bridges)
// A table that only hangs off ONE seed is not a bridge.
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

/** Intermediate tables that connect two DIFFERENT seed tables within
 *  `maxHops` hops (seedA — … — seedB). A non-seed node is a bridge when two
 *  distinct seeds are reachable from it and the two smallest distances sum to
 *  at most `maxHops`; a node that only hangs off ONE seed is not a bridge — it
 *  is just another candidate for recall, not join topology. `maxHops < 2`
 *  yields no bridges (1 = bridging off).
 *
 *  `universe` (when given) restricts BOTH the traversal and the result to
 *  known tables — the chat pipeline passes the datasource's checked tables so
 *  an unchecked (hidden) or dangling name never enters the schema. Sorted for
 *  determinism. */
export function joinBridgeTables(
  edges: TableRelationEdge[],
  seeds: Array<string | undefined>,
  universe?: Iterable<string>,
  maxHops = 2,
): string[] {
  const seedSet = new Set(
    seeds.filter((s): s is string => typeof s === 'string' && s.trim() !== ''),
  );
  if (seedSet.size < 2 || maxHops < 2) return [];
  const adj = adjacency(edges);
  // Seeds always stay traversable even when a caller's universe omits one.
  const allowed = universe ? new Set([...universe, ...seedSet]) : null;

  // BFS from every seed over the allowed graph; a node reachable from two
  // distinct seeds can sit on a joining path. Keeping all distances lets a
  // bridge be judged by the sum of its two nearest seeds.
  const distances = new Map<string, number[]>();
  for (const seed of seedSet) {
    const dist = new Map<string, number>([[seed, 0]]);
    const queue: string[] = [seed];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      const d = dist.get(node) ?? 0;
      if (d >= maxHops) continue;
      for (const next of adj.get(node) ?? []) {
        if (allowed && !allowed.has(next)) continue;
        if (dist.has(next)) continue;
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
    for (const [node, d] of dist) {
      if (node === seed) continue;
      const list = distances.get(node) ?? [];
      list.push(d);
      distances.set(node, list);
    }
  }

  const bridges: string[] = [];
  for (const [node, list] of distances) {
    if (seedSet.has(node) || list.length < 2) continue;
    list.sort((a, b) => a - b);
    if (list[0] + list[1] <= maxHops) bridges.push(node);
  }
  return bridges.sort();
}
