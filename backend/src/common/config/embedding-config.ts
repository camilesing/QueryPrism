// System-wide effective embedding + clarify-gate strategy, resolved once per
// task boundary.
//
// 23 retrieval-strategy parameters resolve with the priority
//   saved parameter value (SystemVariable type='parameter', name
//   '<group>.<snake_key>') > startup env > code default.
//   SystemVariable's parameter group is the store — the same store
//   chat.sample_data_enabled uses. The 10 embedding.* keys drive vector/k
//   keyword retrieval; the 4 clarify.* keys drive the chat pipeline's
//   clarify gate (ask-the-user before stuffing an ambiguous schema); the
//   5 semantic.* keys drive the semantic layer (M2 rule 2 + the M3
//   dimension-enum collector); the 4 metric.*/naming.* keys drive the M4
//   metric-definition and naming-rule prompt injection (metric.enabled /
//   metric.max_definitions / metric.similarity_threshold / naming.enabled).
//
// Parsing is STRICT on saved values:
// booleans only accept real booleans or "true"/"false" (never 0/1), counts
// only positive integers, similarities/alpha only finite numbers in [0,1].
// An invalid saved row throws — save-side validation rejects bad input up
// front, so a load-time failure means the row was hand-edited and silently
// falling back would run a different strategy than the page displays.
import { PrismaService } from '../../database/prisma.service';
import { jsonValueToString } from '../utils/json-value';

/** Immutable snapshot — take once at the start of a chat task / background
 *  job; rules must not switch mid-task (ADR 0001). */
export interface EmbeddingConfig {
  /** Knowledge vectorization (terminology + data-training) generation/recall. */
  enabled: boolean;
  terminologySimilarity: number;
  terminologyTopCount: number;
  dataTrainingSimilarity: number;
  dataTrainingTopCount: number;
  /** Table + datasource vector generation / pre-filtering. */
  tableEnabled: boolean;
  tableCount: number;
  /** Vector weight in table fusion; keyword weight is 1 - alpha. */
  tableAlpha: number;
  /** Keyword extraction / terminology expansion / fusion (independent). */
  keywordEnabled: boolean;
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
   *  effective semantics, stuff only the top semantic.max_tables of them. */
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
  /** Metric system (MetaDataImprove M4): match the question against the
   *  actor's metric dictionary and inject the matched definitions' calibers
   *  into the generate_sql prompt. */
  metricEnabled: boolean;
  /** Cap on rendered metric definitions per question (prompt budget). */
  metricMaxDefinitions: number;
  /** Cosine similarity a metric vector hit must EXCEED to supplement the
   *  literal matcher (metric recall degrades to literal-only when the vector
   *  index or the embedding provider is unavailable). */
  metricSimilarityThreshold: number;
  /** Data standards (M4): inject naming-dictionary standard translations
   *  matched by the question text into the generate_sql prompt. */
  namingEnabled: boolean;
}

/** camelCase field → persisted parameter key. */
const PARAMETER_KEYS: Record<keyof EmbeddingConfig, string> = {
  enabled: 'embedding.enabled',
  terminologySimilarity: 'embedding.terminology_similarity',
  terminologyTopCount: 'embedding.terminology_top_count',
  dataTrainingSimilarity: 'embedding.data_training_similarity',
  dataTrainingTopCount: 'embedding.data_training_top_count',
  tableEnabled: 'embedding.table_enabled',
  tableCount: 'embedding.table_count',
  tableAlpha: 'embedding.table_alpha',
  keywordEnabled: 'embedding.keyword_enabled',
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
  metricSimilarityThreshold: 'metric.similarity_threshold',
  namingEnabled: 'naming.enabled',
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
  'enabled',
  'tableEnabled',
  'keywordEnabled',
  'clarifyEnabled',
  'semanticEnabled',
  'metricEnabled',
  'namingEnabled',
]);
const INTEGER_FIELDS = new Set<keyof EmbeddingConfig>([
  'terminologyTopCount',
  'dataTrainingTopCount',
  'tableCount',
  'datasourceCount',
  'clarifyTableThreshold',
  'clarifyMaxSelect',
  'clarifyMaxRounds',
  'semanticMaxTables',
  'semanticEnumMaxValues',
  'semanticEnumScanRows',
  'semanticEnumCooldown',
  'metricMaxDefinitions',
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

/** Startup (env) layer — code defaults. Legacy MCB keys (EMBEDDING_THRESHOLD
 *  / EMBEDDING_TOP_K) feed the terminology pair when the current keys are
 *  absent. */
function envDefaults(): EmbeddingConfig {
  return {
    enabled: envBool('EMBEDDING_ENABLED', true),
    terminologySimilarity: envNumber(
      'EMBEDDING_TERMINOLOGY_SIMILARITY',
      'EMBEDDING_THRESHOLD',
      0.4,
    ),
    terminologyTopCount: Math.max(
      1,
      Math.floor(
        envNumber('EMBEDDING_TERMINOLOGY_TOP_COUNT', 'EMBEDDING_TOP_K', 5),
      ),
    ),
    dataTrainingSimilarity: envNumber(
      'EMBEDDING_DATA_TRAINING_SIMILARITY',
      'EMBEDDING_THRESHOLD',
      0.4,
    ),
    dataTrainingTopCount: Math.max(
      1,
      Math.floor(
        envNumber('EMBEDDING_DATA_TRAINING_TOP_COUNT', 'EMBEDDING_TOP_K', 5),
      ),
    ),
    tableEnabled: envBool('TABLE_EMBEDDING_ENABLED', true),
    tableCount: Math.max(
      1,
      Math.floor(envNumber('TABLE_EMBEDDING_COUNT', undefined, 10)),
    ),
    tableAlpha: envNumber('TABLE_EMBEDDING_ALPHA', undefined, 0.4),
    keywordEnabled: envBool('TABLE_EMBEDDING_KEYWORD_ENABLED', true),
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
      Math.floor(envNumber('SEMANTIC_MAX_TABLES', undefined, 1)),
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
    // Stricter than the terminology default (0.4): metric names are short and
    // domain-adjacent ("订单量" vs "支付金额"), so a loose threshold would
    // force-stuff unrelated metric tables into the prompt.
    metricSimilarityThreshold: envNumber(
      'METRIC_SIMILARITY_THRESHOLD',
      undefined,
      0.55,
    ),
    namingEnabled: envBool('NAMING_ENABLED', true),
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
