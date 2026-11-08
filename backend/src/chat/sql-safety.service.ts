// SqlSafetyService — validates LLM-generated SQL before it reaches the
// datasource connector. Three layers, belt-and-suspenders (the DbConnector
// also enforces a read-only prefix, but a defense-in-depth check here lets the
// chat pipeline fail fast with a clear SSE error instead of a raw DB throw):
//   1. Read-only prefix guard (SELECT/WITH/SHOW/EXPLAIN/DESCRIBE/PRAGMA only).
//   2. Statement-type denylist over the parsed AST (INSERT/UPDATE/DELETE/DDL
//      anywhere — node-sql-parser's tableList recurses into CTEs/subqueries;
//      CTE-embedded DML is additionally rejected because it fails to parse).
//   3. Table whitelist: every referenced real table must be one of the
//      datasource's checked tables (case-insensitive; CTE names are excluded).
//
// Known limitation: node-sql-parser is weaker than sqlglot on PG/CTE edge cases
// (see .zcode/notes/implementation-decisions.md risks) — the whitelist + the
// connector's read-only prefix cover the gap in practice.
import { Injectable } from '@nestjs/common';
import { Parser } from 'node-sql-parser';

/** Leading keywords that may begin a read-only statement. */
const READONLY_PREFIXES = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'PRAGMA',
]);

/** Statement types that mutate data or schema — rejected wherever they appear
 *  in the parsed tree (tableList recurses into CTEs and subqueries). */
const MUTATING_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'alter',
  'drop',
  'truncate',
  'create',
  'rename',
  'replace',
  'merge',
  'call',
  'set',
]);

export interface SqlSafetyResult {
  ok: boolean;
  /** Every real (non-CTE) table referenced, in discovery order, deduped. */
  tables: string[];
  reason?: string;
}

type CteAst = { name?: { value?: string }; with?: CteAst[] } & Record<
  string,
  unknown
>;

@Injectable()
export class SqlSafetyService {
  private readonly parser = new Parser();

  /** Extract every referenced (non-CTE) table name from the SQL. Throws when
   *  the SQL can't be parsed — callers wrap in validate() for a soft result. */
  extractTableNames(sql: string): string[] {
    const clean = this.stripFences(sql).trim();
    const ast = this.parser.astify(clean);
    const cteNames = this.collectCteNames(ast);
    const list = this.parser.tableList(clean);
    const tables = new Set<string>();
    for (const entry of list) {
      const table = entry.split('::')[2];
      if (table && !cteNames.has(table)) tables.add(table);
    }
    return [...tables];
  }

  /** Read-only + statement-type + table-whitelist guard. Never throws — a
   *  parse failure or any DML/DDL anywhere yields { ok: false }. */
  validate(sql: string, allowedTables: string[]): SqlSafetyResult {
    const clean = this.stripFences(sql).trim();
    const prefixMatch = clean.match(/^\s*(\w+)/);
    const prefix = (prefixMatch?.[1] ?? '').toUpperCase();
    if (!READONLY_PREFIXES.has(prefix)) {
      return {
        ok: false,
        tables: [],
        reason: '仅允许查询语句（SELECT/WITH/SHOW/EXPLAIN/DESCRIBE/PRAGMA）',
      };
    }

    let ast: unknown;
    let list: string[];
    try {
      ast = this.parser.astify(clean);
      list = this.parser.tableList(clean);
    } catch (e) {
      return {
        ok: false,
        tables: [],
        reason: `SQL 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const cteNames = this.collectCteNames(ast);
    const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
    const tables: string[] = [];
    for (const entry of list) {
      const parts = entry.split('::');
      const type = parts[0];
      const table = parts[2];
      if (type && MUTATING_TYPES.has(type)) {
        return {
          ok: false,
          tables,
          reason: `仅允许查询语句，检测到 ${type.toUpperCase()}`,
        };
      }
      if (table && cteNames.has(table)) continue; // virtual CTE name
      if (table) tables.push(table);
      if (table && !allowed.has(table.toLowerCase())) {
        return { ok: false, tables, reason: `表 ${table} 不在允许的白名单内` };
      }
    }
    return { ok: true, tables: [...new Set(tables)] };
  }

  /** Strip ```sql ... ``` markdown fences the LLM sometimes wraps around SQL. */
  private stripFences(sql: string): string {
    return sql
      .replace(/^\s*```[a-zA-Z]*\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();
  }

  /** Collect CTE names (WITH x AS (...)) so they can be excluded from the
   *  real-table whitelist check — they're virtual, defined by the query. */
  private collectCteNames(ast: unknown): Set<string> {
    const stmts = Array.isArray(ast) ? ast : [ast];
    const names = new Set<string>();
    for (const s of stmts) {
      const w = (s as CteAst | null)?.with;
      if (!Array.isArray(w)) continue;
      for (const cte of w) {
        const name = cte?.name?.value;
        if (typeof name === 'string') names.add(name);
      }
    }
    return names;
  }
}
