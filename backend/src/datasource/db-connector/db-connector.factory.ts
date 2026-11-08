// Builds a DbConnector for a given Datasource. The connector owns its own
// pooled connections; callers create one per operation and call close() when
// done. The `configuration` field is AES-128-ECB encrypted by the
// frontend (views/ds/js/aes.ts, key 'QueryPrism123456') — the backend stores +
// returns that ciphertext verbatim and decrypts here only when a connector needs
// the plaintext params. See frontend-config-crypto.ts for why
// this is a separate path from common/utils/aes.ts (GCM + env AES_KEY) which
// still guards AiModel.apiKey / ApiKey.secretKey / Assistant.appSecret at rest.
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  decryptFrontendConfig,
  encryptFrontendConfig,
} from '../frontend-config-crypto';
import { normalizeDatasourceType } from '../datasource-type';
import { ExcelConnector } from './excel.connector';
import { MysqlConnector } from './mysql.connector';
import { PostgresConnector } from './postgres.connector';
import { SqliteConnector } from './sqlite.connector';
import type { ConnectionConfig, DbConnector } from './db-connector.interface';
import { tr } from '../../common/i18n/translate';

/** Minimal shape of a Datasource row needed to build a connector. */
export interface DatasourceConnectorInput {
  type: string;
  configuration: string | null;
}

/** Frontend form values (`views/ds/js/ds-type.ts`) submit connection keys
 *  named `username`/`password`/`database`/`dbSchema`. The connectors speak the
 *  wire shape (`user`/`pwd`/`db`/`schema`), so normalise keys here; type
 *  aliases (`pg` → `postgresql`) are resolved by normalizeDatasourceType. */
const CONFIG_KEY_ALIASES: Array<[from: string, to: string]> = [
  ['username', 'user'],
  ['password', 'pwd'],
  ['database', 'db'],
  ['dbSchema', 'schema'],
];

function normalizeConfiguration(input: ConnectionConfig): ConnectionConfig {
  const cfg: ConnectionConfig = { ...input };
  for (const [from, to] of CONFIG_KEY_ALIASES) {
    if (cfg[to] === undefined && cfg[from] !== undefined) {
      cfg[to] = cfg[from];
    }
  }
  const rawPort = (cfg as Record<string, unknown>).port;
  if (typeof rawPort === 'string' && rawPort.trim() !== '') {
    cfg.port = Number(rawPort);
  }
  return cfg;
}

@Injectable()
export class DbConnectorFactory {
  constructor(private readonly config: ConfigService) {}

  /** Decrypt the stored configuration ciphertext into a typed ConnectionConfig.
   *  Returns {} for tampered/wrong-key/empty input — never throws — so a bad
   *  row surfaces as a connection failure rather than a 500. */
  decryptConfiguration(
    configuration: string | null | undefined,
  ): ConnectionConfig {
    return decryptFrontendConfig(configuration);
  }

  /** Encrypt a plaintext ConnectionConfig for storage. Returns null for empty
   *  configs so the column stays nullable. Output is byte-identical to what
   *  the frontend's aes.ts produces, so a re-save of an unchanged config is a
   *  no-op (deterministic ECB, no IV). */
  encryptConfiguration(
    cfg: ConnectionConfig | undefined | null,
  ): string | null {
    if (!cfg || Object.keys(cfg).length === 0) return null;
    return encryptFrontendConfig(cfg);
  }

  /**
   * Build a connector for a datasource. Caller owns the lifecycle: call
   * close() when finished (typically in a finally block).
   */
  create(datasource: DatasourceConnectorInput): DbConnector {
    const cfg = normalizeConfiguration(
      this.decryptConfiguration(datasource.configuration),
    );
    switch (normalizeDatasourceType(datasource.type)) {
      case 'mysql':
        return new MysqlConnector(cfg);
      case 'postgresql':
        return new PostgresConnector(cfg);
      case 'sqlite':
        return new SqliteConnector(cfg);
      case 'excel':
        // Imported Excel sheets live in the app DB's dedicated schema; the
        // datasource configuration only records the created table names.
        return new ExcelConnector(
          this.excelConnectionConfig(),
          this.excelTableNames(cfg),
        );
      default:
        throw new BadRequestException(
          tr('datasource.type_unsupported', { type: datasource.type }),
        );
    }
  }

  /** Build a pg ConnectionConfig from DATABASE_URL + the Excel store schema. */
  private excelConnectionConfig(): ConnectionConfig {
    const url =
      this.config.get<string>('DATABASE_URL') ?? process.env.DATABASE_URL;
    if (!url) {
      throw new BadRequestException(
        'DATABASE_URL 未配置，无法连接 Excel 数据源',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException(tr('datasource.database_url_invalid'));
    }
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 5432,
      user: decodeURIComponent(parsed.username),
      pwd: decodeURIComponent(parsed.password),
      db: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      schema: this.config.get<string>('excel.storeSchema') ?? 'excel_store',
    };
  }

  /** Extract the imported table names from configuration.sheets. */
  private excelTableNames(cfg: ConnectionConfig): string[] {
    let raw: unknown = (cfg as Record<string, unknown>).sheets;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) =>
        item && typeof item === 'object'
          ? (item as { tableName?: unknown }).tableName
          : null,
      )
      .filter(
        (name): name is string => typeof name === 'string' && name !== '',
      );
  }

  /** Build a connector and invoke `fn`, guaranteeing close() on exit. */
  async withConnector<T>(
    datasource: DatasourceConnectorInput,
    fn: (connector: DbConnector) => Promise<T>,
  ): Promise<T> {
    const connector = this.create(datasource);
    try {
      return await fn(connector);
    } finally {
      await connector.close();
    }
  }
}
