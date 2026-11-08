// Excel datasource connector. Imported sheets live in the app database's
// `excel_store` schema (ExcelStoreService), so the actual SQL engine is the
// same PostgreSQL implementation. This wrapper narrows introspection to the
// tables recorded in the datasource configuration — the schema itself is
// shared by every Excel datasource, and exposing all of it would leak other
// users' imported tables into recall/prompts.
import type {
  ConnectionTestResult,
  DbConnector,
  FieldMeta,
  QueryResult,
  TableMeta,
} from './db-connector.interface';
import { PostgresConnector } from './postgres.connector';
import type { ConnectionConfig } from './db-connector.interface';
import { tr } from '../../common/i18n/translate';

/** Identifiers that may appear as `name AS (` — CTE definitions. They shadow
 *  table names in FROM/JOIN, so they are allowed even though they are not
 *  imported sheets. (Window function defs match too, but an allowlist only
 *  ever permits, never rejects.) */
const CTE_DEF_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi;

const EXCEL_SCHEMA = 'excel_store';

/** Extract the table names a statement's FROM/JOIN clauses reference.
 *  Handles optional `"name"`/`` `name` `` quoting, an optional `schema.`
 *  qualifier (kept attached so foreign schemas fail membership), skips
 *  subquery parens and set-returning function calls, and drops CTE names. */
export function extractTableRefs(sql: string): Set<string> {
  const ctes = new Set<string>();
  for (const m of sql.matchAll(CTE_DEF_RE)) {
    ctes.add(m[1].toLowerCase());
  }

  const refs = new Set<string>();
  const re = /\b(from|join)\s+/gi;
  while (re.exec(sql) !== null) {
    const rest = sql.slice(re.lastIndex);
    const ref =
      /^((?:\p{L}[\p{L}\p{N}_]*\s*\.\s*)?)["`]?(\p{L}[\p{L}\p{N}_]*)["`]?/u.exec(
        rest,
      );
    if (!ref) continue; // e.g. FROM (subquery)
    const [, qualifier, name] = ref;
    // `FROM fn(...)` / `FROM (VALUES ...)` — a call, not a table reference
    if (!qualifier && /^\s*\(/.test(rest.slice(ref[0].length))) continue;
    if (ctes.has(name.toLowerCase())) continue;
    if (qualifier) {
      const schema = qualifier.replace(/[\s.]/g, '').toLowerCase();
      if (schema === EXCEL_SCHEMA) {
        refs.add(name);
      } else {
        // Explicitly foreign schema (public."User", other.app_table…) — keep
        // the qualifier so it can never match a member sheet name.
        refs.add(`${qualifier.replace(/\s+/g, '')}${name}`);
      }
    } else {
      refs.add(name);
    }
  }
  return refs;
}

export class ExcelConnector implements DbConnector {
  private readonly inner: PostgresConnector;
  private readonly tableNames: string[];

  constructor(cfg: ConnectionConfig, tableNames: string[]) {
    this.inner = new PostgresConnector(cfg);
    this.tableNames = [...new Set(tableNames.filter(Boolean))];
  }

  /** The connector talks to the APP database (full app role) — a statement
   *  may only reference this datasource's imported sheets. */
  private assertTablesAllowed(sql: string): void {
    for (const ref of extractTableRefs(sql)) {
      if (!this.tableNames.includes(ref)) {
        throw new Error(tr('datasource.table_not_in_excel', { ref }));
      }
    }
  }

  async getVersion(): Promise<string> {
    return this.inner.getVersion();
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const result = await this.inner.testConnection();
    return {
      ...result,
      message: result.success ? 'Excel 数据源连接成功' : result.message,
    };
  }

  /** Excel datasources have no user-selectable schema. */
  getSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  getTables(): Promise<TableMeta[]> {
    // Never fall back to inner.getTables(): the shared excel_store schema
    // holds every workspace's sheets and listing it would leak them into
    // syncTable/recall. A datasource with no configured sheets has none.
    return Promise.resolve(
      this.tableNames.map((tableName) => ({
        tableName,
        tableComment: null,
      })),
    );
  }

  async getFields(tableName: string): Promise<FieldMeta[]> {
    if (this.tableNames.length > 0 && !this.tableNames.includes(tableName)) {
      throw new Error(tr('datasource.table_not_in_excel', { ref: tableName }));
    }
    return this.inner.getFields(tableName);
  }

  async execSql(sql: string, limit?: number): Promise<QueryResult> {
    this.assertTablesAllowed(sql);
    return this.inner.execSql(sql, limit);
  }

  async getTableSampleData(tableName: string, limit = 3): Promise<unknown[][]> {
    if (this.tableNames.length > 0 && !this.tableNames.includes(tableName)) {
      throw new Error(tr('datasource.table_not_in_excel', { ref: tableName }));
    }
    const ident = `"${tableName.replace(/"/g, '""')}"`;
    const result = await this.inner.execSql(
      `SELECT * FROM ${ident}`,
      Math.max(0, Math.floor(limit)),
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
