// PostgreSQL implementation of DbConnector. Wraps a `pg` Pool; the schema is
// resolved from ConnectionConfig.schema (default 'public'). Read-only queries
// only; callers own the lifecycle (call close() when done).
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DbConnector,
  FieldMeta,
  QueryResult as DbQueryResult,
  TableMeta,
} from './db-connector.interface';
import { appendLimit } from './limit-clause';
import { tr } from '../../common/i18n/translate';

/** Build the libpq startup option that pins search_path to `schema`.
 *  The GUC value is a double-quoted identifier (`""` escapes a quote), so any
 *  real schema name works — dashes, dots, mixed case (an unquoted value would
 *  be downcased). The server splits the options string on whitespace with
 *  backslash escapes, so whitespace and backslashes are escaped: the value
 *  stays ONE token and cannot smuggle extra `-c` settings. */
function searchPathOption(schema: string): string {
  const quoted = `"${schema.replace(/"/g, '""')}"`;
  return `-c search_path=${quoted.replace(/[\s\\]/g, (c) => `\\${c}`)}`;
}

export class PostgresConnector implements DbConnector {
  private pool: Pool;
  private schema: string;

  constructor(cfg: ConnectionConfig) {
    // Schema names come from the (frontend-encrypted) datasource config and
    // are only ever sent as a bound parameter or via searchPathOption().
    this.schema = cfg.schema || 'public';
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.pwd,
      database: cfg.db,
      max: 10,
      // Tables are resolved through search_path for schema-scoped PG
      // datasources. Without this option an unqualified
      // `SELECT ... FROM table` ignored cfg.schema entirely.
      options: searchPathOption(this.schema),
      ...(cfg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  async getVersion(): Promise<string> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT version() AS v',
    );
    if (res.rows.length === 0) return '';
    const row = res.rows[0] as unknown as { v: string };
    return row.v;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const version = await this.getVersion();
      return { success: true, message: 'PostgreSQL 连接成功', version };
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      return { success: false, message: `PostgreSQL 连接失败: ${msg}` };
    }
  }

  /** List selectable schemas (pg_namespace), but
   *  drops the built-in catalogs — they never hold user tables and picking
   *  one would surface system catalogs in getTables(). */
  async getSchemas(): Promise<string[]> {
    const sql = `SELECT nspname
FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND nspname NOT LIKE 'pg_temp_%'
  AND nspname NOT LIKE 'pg_toast_temp_%'
ORDER BY nspname`;
    const res = await this.pool.query<Record<string, unknown>>(sql);
    return res.rows.map((r) => String(r.nspname));
  }

  async getTables(): Promise<TableMeta[]> {
    const sql = `SELECT c.relname AS table_name,
       obj_description(c.oid) AS table_comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relkind = 'r'
ORDER BY c.relname`;
    const res = await this.pool.query<Record<string, unknown>>(sql, [
      this.schema,
    ]);
    return res.rows.map((r) => ({
      tableName: String(r.table_name),
      tableComment: this.nullableString(r.table_comment),
    }));
  }

  async getFields(tableName: string): Promise<FieldMeta[]> {
    const sql = `SELECT
  a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
  col_description(a.attrelid, a.attnum) AS column_comment,
  EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conrelid = c.oid AND con.contype = 'p'
      AND a.attnum = ANY(con.conkey)
  ) AS is_primary_key,
  a.attnum AS ordinal
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;
    const res = await this.pool.query<Record<string, unknown>>(sql, [
      this.schema,
      tableName,
    ]);
    return res.rows.map((r) => ({
      fieldName: String(r.column_name),
      fieldType: String(r.column_type),
      fieldComment: this.nullableString(r.column_comment),
      isPrimaryKey: Boolean(r.is_primary_key),
      fieldIndex: Number(r.ordinal),
    }));
  }

  async execSql(sql: string, limit?: number): Promise<DbQueryResult> {
    const upper = sql.trim().toUpperCase();
    const allowed = ['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'PRAGMA'];
    if (!allowed.some((k) => upper.startsWith(k))) {
      throw new Error(tr('datasource.query_only'));
    }
    let finalSql = sql.trim();
    if (limit !== undefined) {
      finalSql = appendLimit(finalSql, limit);
    }
    const res = await this.pool.query<Record<string, unknown>>(finalSql);
    return this.buildResult(res);
  }

  async getTableSampleData(tableName: string, limit = 3): Promise<unknown[][]> {
    // Table names come from our own metadata, but a name containing a quote
    // must not break out of the identifier — quoteIdent doubles quotes.
    const safeLimit = Math.max(0, Math.floor(limit));
    const ident = this.quoteIdent(tableName);
    const sql = `SELECT * FROM ${ident} LIMIT ${safeLimit}`;
    const res = await this.pool.query<Record<string, unknown>>(sql);
    return this.buildResult(res).rows;
  }

  async sampleDistinct(
    tableName: string,
    fieldName: string,
    scanRows: number,
  ): Promise<unknown[]> {
    // Bounded scan: DISTINCT over the first N rows only, so a huge table
    // cannot turn the enum probe into a full-table aggregate.
    const rows = Math.max(1, Math.floor(scanRows));
    const sql =
      `SELECT DISTINCT v FROM (SELECT ${this.quoteIdent(fieldName)} AS v ` +
      `FROM ${this.quoteIdent(tableName)} LIMIT ${rows}) s`;
    const res = await this.pool.query<Record<string, unknown>>(sql);
    return res.rows.map((r) => r.v);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Flatten a pg QueryResult into columns + row-major value arrays. */
  private buildResult(res: QueryResult<QueryResultRow>): DbQueryResult {
    const columns =
      res.fields.length > 0
        ? res.fields.map((f) => f.name)
        : Object.keys(res.rows[0] ?? {});
    const rows = res.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return columns.map((c) => row[c]);
    });
    return { columns, rows };
  }

  /** Quote a SQL identifier: double-quote with internal-quote doubling. */
  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Treat a nullable string cell as `string | null` (pg returns text or NULL). */
  private nullableString(v: unknown): string | null {
    return v as string | null;
  }
}
