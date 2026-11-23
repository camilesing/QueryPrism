// MySQL connector backed by a mysql2/promise connection pool. Implements the
// DbConnector interface (see db-connector.interface.ts).
import { createPool } from 'mysql2/promise';
import type { FieldPacket, RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DbConnector,
  FieldMeta,
  QueryResult,
  TableMeta,
} from './db-connector.interface';
import { appendLimit } from './limit-clause';
import { assertSingleStatement } from './single-statement';
import { tr } from '../../common/i18n/translate';

/** First-token keywords allowed by the read-only execSql guard. */
const READONLY_PREFIXES = /^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|PRAGMA)\b/i;

export class MysqlConnector implements DbConnector {
  private readonly pool: Pool;

  private readonly cfg: ConnectionConfig;

  constructor(cfg: ConnectionConfig) {
    this.cfg = cfg;
    this.pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.pwd,
      database: cfg.db,
      waitForConnections: true,
      connectionLimit: 10,
      ...(cfg.ssl ? { ssl: {} } : {}),
    });
  }

  /** Run a query and return typed rows + field metadata. */
  private async execute(
    sql: string,
    params?: Array<string | number | null | undefined>,
  ): Promise<{ rows: RowDataPacket[]; fields: FieldPacket[] }> {
    const [rows, fields] = params
      ? await this.pool.query(sql, params)
      : await this.pool.query(sql);
    return { fields, rows: rows as unknown as RowDataPacket[] };
  }

  async getVersion(): Promise<string> {
    const { rows } = await this.execute('SELECT VERSION() AS v');
    const row = rows[0] as unknown as Record<string, unknown>;
    const version = row?.v;
    return typeof version === 'string' ? version : '';
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const version = await this.getVersion();
      return { success: true, message: 'MySQL 连接成功', version };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `MySQL 连接失败: ${msg}` };
    }
  }

  /** MySQL has no separate schema layer (the database is selected in the
   *  connection form), so there is nothing to offer here. */
  getSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async getTables(): Promise<TableMeta[]> {
    let schema = this.cfg.db;
    if (!schema) {
      const fallback = await this.execute('SELECT DATABASE() AS d');
      const row = fallback.rows[0] as unknown as Record<string, unknown>;
      schema = (row?.d as string | null) ?? undefined;
    }
    const sql =
      'SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment ' +
      'FROM information_schema.TABLES ' +
      "WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' " +
      'ORDER BY TABLE_NAME';
    const { rows } = await this.execute(sql, [schema ?? '']);
    const records = rows as unknown as Record<string, unknown>[];
    return records.map((r) => ({
      tableName: r.tableName as string,
      tableComment: (r.tableComment as string) || null,
    }));
  }

  async getFields(tableName: string): Promise<FieldMeta[]> {
    const sql =
      'SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, ' +
      'COLUMN_COMMENT AS columnComment, ' +
      "CASE COLUMN_KEY WHEN 'PRI' THEN 1 ELSE 0 END AS isPrimaryKey, " +
      'ORDINAL_POSITION AS fieldIndex ' +
      'FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ' +
      'ORDER BY ORDINAL_POSITION';
    const { rows } = await this.execute(sql, [this.cfg.db, tableName]);
    const records = rows as unknown as Record<string, unknown>[];
    return records.map((r) => ({
      fieldName: r.columnName as string,
      fieldType: r.columnType as string,
      fieldComment: (r.columnComment as string) || null,
      isPrimaryKey: Number(r.isPrimaryKey) === 1,
      fieldIndex: Number(r.fieldIndex),
    }));
  }

  async execSql(sql: string, limit?: number): Promise<QueryResult> {
    const trimmed = sql.trim();
    if (!READONLY_PREFIXES.test(trimmed)) {
      throw new Error(tr('datasource.query_only'));
    }
    assertSingleStatement(sql);
    let finalSql = sql;
    if (limit !== undefined) {
      finalSql = appendLimit(sql, limit);
    }
    const { rows, fields } = await this.execute(finalSql);
    let columns = fields.map((f) => f.name);
    const records = rows as unknown as Record<string, unknown>[];
    if (columns.length === 0 && records.length > 0) {
      columns = Object.keys(records[0] ?? {});
    }
    const resultRows = records.map((r) => columns.map((c) => r[c]));
    return { columns, rows: resultRows };
  }

  async getTableSampleData(tableName: string, limit = 3): Promise<unknown[][]> {
    const { rows, fields } = await this.execute('SELECT * FROM ?? LIMIT ?', [
      tableName,
      limit,
    ]);
    const columns = fields.map((f) => f.name);
    const records = rows as unknown as Record<string, unknown>[];
    return records.map((r) => columns.map((c) => r[c]));
  }

  async sampleDistinct(
    tableName: string,
    fieldName: string,
    scanRows: number,
  ): Promise<unknown[]> {
    // Bounded scan (see PostgresConnector.sampleDistinct); ?? placeholders
    // carry the identifier quoting, the derived table alias is required.
    const rows = Math.max(1, Math.floor(scanRows));
    const { rows: records } = await this.execute(
      'SELECT DISTINCT v FROM (SELECT ?? AS v FROM ?? LIMIT ?) s',
      [fieldName, tableName, rows],
    );
    return (records as unknown as Record<string, unknown>[]).map((r) => r.v);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
