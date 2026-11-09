// Database connector abstraction. One implementation per supported engine
// (MySQL / PostgreSQL / SQLite). Built by DbConnectorFactory from a
// Datasource's decrypted `configuration`. Callers own the lifecycle — call
// close() when done (typically one connector per request/sync operation).

/** Decrypted connection configuration stored AES-encrypted in Datasource.configuration. */
export interface ConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  pwd?: string; // password
  db?: string; // SQLite: file path; MySQL/PG: database name
  schema?: string; // PostgreSQL schema; ignored for SQLite/MySQL
  ssl?: boolean;
  [key: string]: unknown;
}

/** A table discovered from the source database (system tables excluded). */
export interface TableMeta {
  tableName: string;
  tableComment: string | null;
}

/** A column discovered from the source database. */
export interface FieldMeta {
  fieldName: string;
  fieldType: string;
  fieldComment: string | null;
  isPrimaryKey: boolean;
  fieldIndex: number; // ordinal position (1-based where applicable)
}

/** A flattened query result: column names + row-major value arrays. */
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  version?: string;
}

export interface DbConnector {
  /** Ping the database and return its version. */
  testConnection(): Promise<ConnectionTestResult>;

  /** List selectable schemas (engines without a schema layer return []). */
  getSchemas(): Promise<string[]>;

  /** List user tables (system/schema tables excluded). */
  getTables(): Promise<TableMeta[]>;

  /** Column metadata for a single table. */
  getFields(tableName: string): Promise<FieldMeta[]>;

  /** DB product version string (e.g. "MySQL 8.0.34"). */
  getVersion(): Promise<string>;

  /** Execute a SELECT; returns columns + rows (a row limit is applied). */
  execSql(sql: string, limit?: number): Promise<QueryResult>;

  /** First N rows of a table (sample data fed to the SQL prompt). */
  getTableSampleData(tableName: string, limit?: number): Promise<unknown[][]>;

  /** Distinct values of one column, drawn from at most `scanRows` source
   *  rows — the dimension-enum collector's low-cardinality probe
   *  (MetaDataImprove M3.3). Returns the raw single-column values; callers
   *  own the cardinality check. */
  sampleDistinct(
    tableName: string,
    fieldName: string,
    scanRows: number,
  ): Promise<unknown[]>;

  /** Release pooled connections. */
  close(): Promise<void> | void;
}
