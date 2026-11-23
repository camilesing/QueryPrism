// System-wide effective embedding + clarify-gate strategy, resolved once per
// task boundary.
//
// 18 runtime parameters resolve with the priority
//   saved parameter value (SystemVariable type='parameter', name
//   '<group>.<snake_key>') > startup env > code default.
//   SystemVariable's parameter group is the store — the same store
//   chat.sample_data_enabled uses. The 3 embedding.* keys drive table /
//   datasource vector+keyword retrieval; the 4 clarify.* keys drive the chat pipeline's
//   clarify gate (ask-the-user before stuffing an ambiguous schema); the
//   5 semantic.* keys drive the semantic layer (M2 rule 2 + the M3
//   dimension-enum collector); the 3 metric.*/naming.* keys drive the M4
//   metric-definition and naming-rule prompt injection (metric.enabled /
//   metric.max_definitions / naming.enabled).
// Not tunable (deliberately hard-coded): keyword extraction always runs —
// the extracted keywords are the ONLY match source for metric definitions,
// naming rules and the semantic prompt decoration; the table-recall width is
// the constant TABLE_RECALL_TOP_K (datasource/table-recall.ts).
// MetaDataImprove M7 adds 3 query-cost keys: quota.max_rows caps the rows
//   of ONE execSql call (the funnel every chat/dashboard/MCP query goes
//   through); cache.enabled + cache.ttl_seconds drive the SQL result cache
//   (off by default — stale-rollout safe).
//
// Parsing is STRICT on saved values:
// booleans only accept real booleans or "true"/"false" (never 0/1), counts
// only positive integers, alpha only a finite number in [0,1].
// An invalid saved row throws — save-side validation rejects bad input up
// front, so a load-time failure means the row was hand-edited and silently
// falling back would run a different strategy than the page displays.
import { PrismaService } from '../../database/prisma.service';
import { jsonValueToString } from '../utils/json-value';

/** Immutable snapshot — take once at the start of a chat task / background
 *  job; rules must not switch mid-task (ADR 0001). */
export interface EmbeddingConfig {
  /** Table + datasource vector generation / pre-filtering. */
  tableEnabled: boolean;
  /** Vector weight in table fusion; keyword weight is 1 - alpha. */
  tableAlpha: number;
  datasourceCount: number;
  /** Clarify gate (MetaDataImprove M1): ask the user to narrow candidate
   *  tables before stuffing the schema when the question is ambiguous. */
  clarifyEnabled: boolean;
  /** Ask only when at least this many candidate tables would be stuffed. */
  clarifyTableThreshold: number;
  /** Max tables the user may pick in one clarify answer. */
  clarifyMaxSelect: number;
  /** Max clarify pauses per record. 1 (default) = never re-ask after the
   *  first answer; >1 lets the gate/need_clarify ask again until the budget
   *  is spent (supplement texts accumulate across rounds). */
  clarifyMaxRounds: number;
  /** Semantic layer (MetaDataImprove M2 rule 2): when candidate tables have
   *  effective semantics, stuff only the top semantic.max_tables of them.
   *  Only engages below the recall width (TABLE_RECALL_TOP_K): at the default
   *  3 a Top-3 recall never exceeds it, so rule 2 narrows nothing until an
   *  admin lowers this. */
  semanticEnabled: boolean;
  semanticMaxTables: number;
  /** Dimension-enum collector (MetaDataImprove M3.3): a field with more
   *  distinct values than this is NOT low-cardinality — the collect run
   *  skips it instead of caching a meaningless enum list. */
  semanticEnumMaxValues: number;
  /** Row cap for one DISTINCT probe: the sample is drawn from the first
   *  N rows of the table, bounding the scan cost on large tables. */
  semanticEnumScanRows: number;
  /** Per-datasource cooldown (seconds) between collect runs — the rate
   *  limit that keeps repeated clicks from hammering the source DB. */
  semanticEnumCooldown: number;
  /** Metric system (MetaDataImprove M4): match the question's extracted
   *  keywords (exact name/alias equality) against the actor's metric
   *  dictionary and inject the matched definitions' calibers into the
   *  generate_sql prompt. */
  metricEnabled: boolean;
  /** Cap on rendered metric definitions per question (prompt budget). */
  metricMaxDefinitions: number;
  /** Data standards (M4): inject naming-dictionary standard translations
   *  whose term/alias equals an extracted keyword or a name/comment of a
   *  stuffed table into the generate_sql prompt. */
  namingEnabled: boolean;
  /** Query quota (MetaDataImprove M7): row cap for ONE execSql call. The
   * funnel-level guard for agent cost — downstream agents cannot be trusted
   * to self-limit. Callers passing a smaller limit keep it; a larger one is
   * clamped to this cap. */
  quotaMaxRows: number;
  /** SQL result cache (M7): serve repeated identical effective SQL from
   * Postgres instead of re-executing. Default OFF. */
  cacheEnabled: boolean;
  /** Cache entry lifetime in seconds (M7). */
  cacheTtlSeconds: number;
}

/** camelCase field → persisted parameter key. */
const PARAMETER_KEYS: Record<keyof EmbeddingConfig, string> = {
  tableEnabled: 'embedding.table_enabled',
  tableAlpha: 'embedding.table_alpha',
  datasourceCount: 'embedding.datasource_count',
  clarifyEnabled: 'clarify.enabled',
  clarifyTableThreshold: 'clarify.table_threshold',
  clarifyMaxSelect: 'clarify.max_select',
  clarifyMaxRounds: 'clarify.max_rounds',
  semanticEnabled: 'semantic.enabled',
  semanticMaxTables: 'semantic.max_tables',
  semanticEnumMaxValues: 'semantic.enum_max_values',
  semanticEnumScanRows: 'semantic.enum_scan_rows',
  semanticEnumCooldown: 'semantic.enum_cooldown',
  metricEnabled: 'metric.enabled',
  metricMaxDefinitions: 'metric.max_definitions',
  namingEnabled: 'naming.enabled',
  quotaMaxRows: 'quota.max_rows',
  cacheEnabled: 'cache.enabled',
  cacheTtlSeconds: 'cache.ttl_seconds',
};

export const EMBEDDING_PARAMETER_KEYS = Object.values(PARAMETER_KEYS);

/** Reverse lookup: persisted parameter key → config field (null when the key
 *  is not one of the registered strategy parameters). Used by the parameter
 *  save path to strict-validate embedding and clarify rows. */
export function embeddingFieldOfKey(key: string): keyof EmbeddingConfig | null {
  for (const field of Object.keys(
    PARAMETER_KEYS,
  ) as (keyof EmbeddingConfig)[]) {
    if (PARAMETER_KEYS[field] === key) return field;
  }
  return null;
}

const BOOLEAN_FIELDS = new Set<keyof EmbeddingConfig>([
  'tableEnabled',
  'clarifyEnabled',
  'semanticEnabled',
  'metricEnabled',
  'namingEnabled',
  'cacheEnabled',
]);
const INTEGER_FIELDS = new Set<keyof EmbeddingConfig>([
  'datasourceCount',
  'clarifyTableThreshold',
  'clarifyMaxSelect',
  'clarifyMaxRounds',
  'semanticMaxTables',
  'semanticEnumMaxValues',
  'semanticEnumScanRows',
  'semanticEnumCooldown',
  'metricMaxDefinitions',
  'quotaMaxRows',
  'cacheTtlSeconds',
]);

/** Object-safe display of an invalid value for error messages. */
function showValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

/** Strict parse of ONE saved value. Throws on anything shape-invalid — no
 *  silent truncation/substitution. */
export function parseEmbeddingParameter(
  field: keyof EmbeddingConfig,
  value: unknown,
): boolean | number {
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value === 'boolean') return value;
    const s =
      typeof value === 'string' ? value.trim().toLowerCase() : undefined;
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw new Error(
      `参数 ${PARAMETER_KEYS[field]} 的值非法: ${showValue(value)}`,
    );
  }
  if (typeof value === 'boolean' || value === null || value === undefined) {
    throw new Error(
      `参数 ${PARAMETER_KEYS[field]} 的值非法: ${showValue(value)}`,
    );
  }
  if (INTEGER_FIELDS.has(field)) {
    // booleans/null already rejected above → string | number remain
    const s =
      typeof value === 'number' ? String(value) : (value as string).trim();
    if (!/^[0-9]+$/.test(s) || parseInt(s, 10) <= 0) {
      throw new Error(`参数 ${PARAMETER_KEYS[field]} 必须是正整数: ${s}`);
    }
    return parseInt(s, 10);
  }
  const f =
    typeof value === 'number' ? value : Number((value as string).trim());
  if (!Number.isFinite(f) || f < 0 || f > 1) {
    throw new Error(
      `参数 ${PARAMETER_KEYS[field]} 必须是 [0,1] 内的数值: ${showValue(value)}`,
    );
  }
  return f;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const t = v.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return fallback;
}

function envNumber(
  name: string | undefined,
  legacy: string | undefined,
  fallback: number,
): number {
  for (const key of [name, legacy]) {
    if (!key) continue;
    const v = process.env[key];
    if (v === undefined || v === '') continue;
    const f = Number(v);
    if (Number.isFinite(f)) return f;
  }
  return fallback;
}

/** Startup (env) layer — code defaults. */
function envDefaults(): EmbeddingConfig {
  return {
    tableEnabled: envBool('TABLE_EMBEDDING_ENABLED', true),
    tableAlpha: envNumber('TABLE_EMBEDDING_ALPHA', undefined, 0.4),
    datasourceCount: Math.max(
      1,
      Math.floor(envNumber('DS_EMBEDDING_COUNT', undefined, 10)),
    ),
    clarifyEnabled: envBool('CLARIFY_ENABLED', true),
    clarifyTableThreshold: Math.max(
      1,
      Math.floor(envNumber('CLARIFY_TABLE_THRESHOLD', undefined, 3)),
    ),
    clarifyMaxSelect: Math.max(
      1,
      Math.floor(envNumber('CLARIFY_MAX_SELECT', undefined, 3)),
    ),
    // >=1 pauses per record; 1 (default) never re-asks after the user's first
    // answer. >1 lets the gate/need_clarify ask again while budget remains.
    clarifyMaxRounds: Math.max(
      1,
      Math.floor(envNumber('CLARIFY_MAX_ROUNDS', undefined, 1)),
    ),
    semanticEnabled: envBool('SEMANTIC_ENABLED', true),
    semanticMaxTables: Math.max(
      1,
      Math.floor(envNumber('SEMANTIC_MAX_TABLES', undefined, 3)),
    ),
    semanticEnumMaxValues: Math.max(
      1,
      Math.floor(envNumber('SEMANTIC_ENUM_MAX_VALUES', undefined, 50)),
    ),
    semanticEnumScanRows: Math.max(
      1,
      Math.floor(envNumber('SEMANTIC_ENUM_SCAN_ROWS', undefined, 10000)),
    ),
    semanticEnumCooldown: Math.max(
      1,
      Math.floor(envNumber('SEMANTIC_ENUM_COOLDOWN', undefined, 60)),
    ),
    metricEnabled: envBool('METRIC_ENABLED', true),
    metricMaxDefinitions: Math.max(
      1,
      Math.floor(envNumber('METRIC_MAX_DEFINITIONS', undefined, 5)),
    ),
    namingEnabled: envBool('NAMING_ENABLED', true),
    // M7: QUOTA_MAX_ROWS wins, legacy CHAT_LIMIT_ROWS (the pre-parameter env
    // cap DatasourceService used to read directly) feeds the default.
    quotaMaxRows: Math.max(
      1,
      Math.floor(envNumber('QUOTA_MAX_ROWS', 'CHAT_LIMIT_ROWS', 1000)),
    ),
    cacheEnabled: envBool('CACHE_ENABLED', false),
    cacheTtlSeconds: Math.max(
      1,
      Math.floor(envNumber('CACHE_TTL_SECONDS', undefined, 300)),
    ),
  };
}

/** Resolve the effective config: saved parameter rows (one query) over env
 *  defaults. Rows are read raw (Json value or string via jsonValueToString)
 *  and strict-parsed; an invalid row throws. */
export async function resolveEmbeddingConfig(
  prisma: PrismaService,
): Promise<EmbeddingConfig> {
  const cfg = envDefaults();
  const rows = await prisma.systemVariable.findMany({
    where: { type: 'parameter', name: { in: EMBEDDING_PARAMETER_KEYS } },
  });
  const byName = new Map(rows.map((r) => [r.name, r.value]));
  for (const field of Object.keys(
    PARAMETER_KEYS,
  ) as (keyof EmbeddingConfig)[]) {
    const raw = byName.get(PARAMETER_KEYS[field]);
    if (raw === undefined) continue; // not saved — env/default stands
    const parsed = parseEmbeddingParameter(
      field,
      typeof raw === 'string' ? jsonValueToString(raw) : raw,
    );
    // boolean|number covers every field; the union-keyed write needs a cast
    (cfg as Record<keyof EmbeddingConfig, boolean | number>)[field] = parsed;
  }
  return cfg;
}
