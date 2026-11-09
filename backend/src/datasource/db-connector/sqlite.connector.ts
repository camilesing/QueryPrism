// SQLite DbConnector backed by better-sqlite3. The driver is synchronous, so
// every async method simply wraps the blocking call to satisfy the interface.
/* eslint-disable @typescript-eslint/require-await -- better-sqlite3 is synchronous; async is only here to satisfy the DbConnector contract */
import Database from 'better-sqlite3';
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DbConnector,
  FieldMeta,
  QueryResult,
  TableMeta,
} from './db-connector.interface';
import { appendLimit } from './limit-clause';
import { tr } from '../../common/i18n/translate';

type SqliteDatabase = InstanceType<typeof Database>;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SqliteConnector implements DbConnector {
  // Opening the DB eagerly would throw from the factory's create() on a bad
  // path and surface as a 500 — so the constructor never throws; the error is
  // stashed and reported through testConnection (failure) / re-thrown from
  // any real query method.
  private readonly db: SqliteDatabase | null;
  private readonly openError: Error | null;

  constructor(cfg: ConnectionConfig) {
    try {
      const db = new Database(cfg.db ?? ':memory:', {});
      db.pragma('journal_mode = WAL');
      this.db = db;
      this.openError = null;
    } catch (err) {
      this.db = null;
      this.openError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /** The live connection, or re-throw the stored open error for query paths. */
  private conn(): SqliteDatabase {
    if (!this.db) {
      throw this.openError ?? new Error('SQLite 未连接');
    }
    return this.db;
  }

  /** Escape and double-quote an identifier (PRAGMA can't bind table names). */
  private quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  /** Reject anything that isn't a bare [A-Za-z_][A-Za-z0-9_]* name. */
  private assertValidIdentifier(name: string): void {
    if (!IDENTIFIER_RE.test(name)) {
      throw new Error('Invalid table name');
    }
  }

  async getVersion(): Promise<string> {
    const { v } = this.conn().prepare('SELECT sqlite_version() AS v').get() as {
      v: string;
    };
    return 'SQLite ' + v;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // An open failure is a connection failure, not an exception to the caller.
    if (this.openError) {
      return {
        success: false,
        message: 'SQLite 连接失败: ' + this.openError.message,
      };
    }
    try {
      this.conn().prepare('SELECT 1').get();
      return {
        success: true,
        message: 'SQLite 连接成功',
        version: await this.getVersion(),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: 'SQLite 连接失败: ' + reason,
      };
    }
  }

  /** SQLite has no schema layer. */
  async getSchemas(): Promise<string[]> {
    return [];
  }

  async getTables(): Promise<TableMeta[]> {
    const rows = this.conn()
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    return rows.map((row) => ({
      tableName: row.name,
      tableComment: null,
    }));
  }

  async getFields(tableName: string): Promise<FieldMeta[]> {
    this.assertValidIdentifier(tableName);
    const columns = this.conn().pragma(
      `table_info(${this.quoteIdent(tableName)})`,
    ) as {
      cid: number;
      name: string;
      type: string | null;
      pk: number;
    }[];
    // PRAGMA table_info already returns rows ordered by cid.
    return columns.map((col) => ({
      fieldName: col.name,
      fieldType: col.type || 'TEXT',
      fieldComment: null,
      isPrimaryKey: col.pk > 0,
      fieldIndex: col.cid,
    }));
  }

  async execSql(sql: string, limit?: number): Promise<QueryResult> {
    const head = sql.trim().toUpperCase();
    if (
      !head.startsWith('SELECT') &&
      !head.startsWith('WITH') &&
      !head.startsWith('SHOW') &&
      !head.startsWith('EXPLAIN') &&
      !head.startsWith('DESCRIBE') &&
      !head.startsWith('PRAGMA')
    ) {
      throw new Error(tr('datasource.query_only'));
    }

    let finalSql = sql;
    if (limit !== undefined) {
      finalSql = appendLimit(sql, limit);
    }

    const stmt = this.conn().prepare(finalSql);
    let columns = stmt.columns().map((col) => col.name);
    const rawRows = stmt.all() as Record<string, unknown>[];
    if (columns.length === 0 && rawRows.length > 0) {
      columns = Object.keys(rawRows[0]);
    }
    const rows = rawRows.map((row) => columns.map((col) => row[col]));
    return { columns, rows };
  }

  async getTableSampleData(tableName: string, limit = 3): Promise<unknown[][]> {
    this.assertValidIdentifier(tableName);
    const stmt = this.conn().prepare(
      `SELECT * FROM ${this.quoteIdent(tableName)} LIMIT ${limit}`,
    );
    let columns = stmt.columns().map((col) => col.name);
    const rawRows = stmt.all() as Record<string, unknown>[];
    if (columns.length === 0 && rawRows.length > 0) {
      columns = Object.keys(rawRows[0]);
    }
    return rawRows.map((row) => columns.map((col) => row[col]));
  }

  async sampleDistinct(
    tableName: string,
    fieldName: string,
    scanRows: number,
  ): Promise<unknown[]> {
    // Bounded scan (see PostgresConnector.sampleDistinct).
    this.assertValidIdentifier(tableName);
    const rows = Math.max(1, Math.floor(scanRows));
    const stmt = this.conn().prepare(
      `SELECT DISTINCT v FROM (SELECT ${this.quoteIdent(fieldName)} AS v ` +
        `FROM ${this.quoteIdent(tableName)} LIMIT ${rows}) s`,
    );
    const rawRows = stmt.all() as Record<string, unknown>[];
    return rawRows.map((r) => r.v);
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
