// SqlSafetyService — validates LLM-generated SQL before it reaches the
// datasource connector. Three layers, belt-and-suspenders (the DbConnector
// also enforces a read-only prefix, but a defense-in-depth check here lets the
// chat pipeline fail fast with a clear SSE error instead of a raw DB throw):
//   1. Read-only prefix guard (SELECT/WITH/SHOW/EXPLAIN/DESCRIBE/PRAGMA only).
//   2. Statement-type denylist over the parsed AST (INSERT/UPDATE/DELETE/DDL
//      anywhere — node-sql-parser's tableList recurses into CTEs/subqueries;
//      CTE-embedded DML is additionally rejected because it fails to parse).
//   3. Table whitelist: every referenced real table must be one of the
//      datasource's checked tables (case-insensitive; CTE names are excluded
//      unless the reference is schema-qualified — `public.orders` is a real
//      table even when a CTE is also called `orders`).
//   Plus three shape rules the parser otherwise lets through: exactly one
//   statement (a batch is reported as an array), no MySQL executable comments
//   (`/*! ... */` hides text from the parser and runs on the server) and no
//   `SELECT ... INTO` (creates a table while starting with SELECT).
//
// Parsing uses the datasource's own SQL dialect: node-sql-parser's default
// grammar is not PostgreSQL and rejects valid generated SQL such as
// `ORDER BY x DESC NULLS LAST` or `::` casts, which would otherwise fail the
// whole chat turn before execution. Statements the dialect parser does not
// model (EXPLAIN / DESCRIBE) fall back to the default grammar.
//
// Known limitation: node-sql-parser is weaker than sqlglot on PG/CTE edge cases
// (see .zcode/notes/implementation-decisions.md risks) — the whitelist + the
// connector's read-only prefix cover the gap in practice.
import { Injectable } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import type { TableColumnAst } from 'node-sql-parser';
import { normalizeDatasourceType } from '../datasource/datasource-type';

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
  'lock',
  'grant',
  'revoke',
]);

/** MySQL executes the body of a `/*!` bang comment; node-sql-parser only
 *  sees a comment, so a table hidden there would never reach the whitelist. */
const EXECUTABLE_COMMENT_RE = /\/\*!/;

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

/** node-sql-parser dialect per normalized datasource type. Excel sheets are
 *  imported into the app PostgreSQL DB, so their generated SQL is PG too. */
const PARSER_DIALECTS: Record<string, string> = {
  mysql: 'MySQL',
  postgresql: 'Postgresql',
  sqlite: 'Sqlite',
  excel: 'Postgresql',
};

@Injectable()
export class SqlSafetyService {
  private readonly parser = new Parser();

  /** Extract every referenced (non-CTE) table name from the SQL. Throws when
   *  the SQL can't be parsed — callers wrap in validate() for a soft result. */
  extractTableNames(sql: string, datasourceType?: string | null): string[] {
    const clean = this.stripFences(sql).trim();
    if (EXECUTABLE_COMMENT_RE.test(clean)) {
      throw new Error('executable comments (/*! ... */) are not allowed');
    }
    const { ast, tableList } = this.parseSql(clean, datasourceType);
    const cteNames = this.collectCteNames(ast);
    const tables = new Set<string>();
    for (const entry of tableList) {
      const table = entry.split('::')[2];
      if (table && !this.isVirtualCte(entry, cteNames)) tables.add(table);
    }
    return [...tables];
  }

  /** Read-only + statement-type + table-whitelist guard. Never throws — a
   *  parse failure or any DML/DDL anywhere yields { ok: false }.
   *  `allowedTables: null` skips only the whitelist (the read-only shape rules
   *  still apply) — for a datasource whose table metadata was never synced. */
  validate(
    sql: string,
    allowedTables: string[] | null = [],
    datasourceType?: string | null,
  ): SqlSafetyResult {
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

    if (EXECUTABLE_COMMENT_RE.test(clean)) {
      return {
        ok: false,
        tables: [],
        reason: '仅允许查询语句，检测到可执行注释（/*! ... */）',
      };
    }

    let parsed: TableColumnAst;
    try {
      parsed = this.parseSql(clean, datasourceType);
    } catch (e) {
      return {
        ok: false,
        tables: [],
        reason: `SQL 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // Exactly one statement. The read-only prefix above only looked at the
    // first one, and the parser reports the other statements' types in upper
    // case (`DROP`), which a lower-case denylist alone would miss.
    if (Array.isArray(parsed.ast)) {
      return { ok: false, tables: [], reason: '仅允许单条查询语句' };
    }
    const statement = parsed.ast as { into?: { type?: string } } | null;
    if (statement?.into?.type === 'into') {
      return {
        ok: false,
        tables: [],
        reason: '仅允许查询语句，检测到 SELECT INTO',
      };
    }

    const cteNames = this.collectCteNames(parsed.ast);
    const enforceWhitelist = allowedTables != null;
    const allowed = new Set((allowedTables ?? []).map((t) => t.toLowerCase()));
    const tables: string[] = [];
    for (const entry of parsed.tableList) {
      const parts = entry.split('::');
      const type = parts[0];
      const table = parts[2];
      if (type && MUTATING_TYPES.has(type.toLowerCase())) {
        return {
          ok: false,
          tables,
          reason: `仅允许查询语句，检测到 ${type.toUpperCase()}`,
        };
      }
      if (table && this.isVirtualCte(entry, cteNames)) continue; // virtual CTE name
      if (table) tables.push(table);
      if (enforceWhitelist && table && !allowed.has(table.toLowerCase())) {
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

  /** Parse under the datasource's dialect, falling back to the default
   *  grammar when the dialect parser doesn't model the statement (e.g.
   *  EXPLAIN / DESCRIBE). One parse yields both the AST and table list. */
  private parseSql(
    sql: string,
    datasourceType?: string | null,
  ): TableColumnAst {
    const dialect = PARSER_DIALECTS[normalizeDatasourceType(datasourceType)];
    if (!dialect) return this.parser.parse(sql);
    try {
      return this.parser.parse(sql, { database: dialect });
    } catch (dialectError) {
      try {
        return this.parser.parse(sql);
      } catch {
        // Report the dialect parser's error — it is the relevant one for the
        // datasource the SQL was generated for.
        throw dialectError;
      }
    }
  }

  /** A reference is a CTE only when it is unqualified: `orders` is the CTE
   *  of `WITH orders AS (...)`, `public.orders` is always a real table (it
   *  must reach the whitelist and the row-permission lookup). node-sql-parser
   *  reports the schema as `null` for unqualified references. */
  private isVirtualCte(entry: string, cteNames: Set<string>): boolean {
    const parts = entry.split('::');
    const three = parts.length >= 3;
    const schema = three ? parts[1] : 'null';
    const table = three ? parts[2] : parts[1];
    return (schema == null || schema === 'null') && cteNames.has(table ?? '');
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
