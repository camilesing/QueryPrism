// System-wide effective embedding strategy, resolved once per task boundary.
//
// 10 retrieval-strategy parameters resolve with the priority
//   saved parameter value (SystemVariable type='parameter', name
//   'embedding.<snake_key>') > startup env > code default.
//   SystemVariable's parameter group is the store — the same store
//   chat.sample_data_enabled uses.
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
};

export const EMBEDDING_PARAMETER_KEYS = Object.values(PARAMETER_KEYS);

/** Reverse lookup: persisted parameter key → config field (null when the key
 *  is not one of the ten embedding parameters). Used by the parameter save
 *  path to strict-validate embedding.* rows. */
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
]);
const INTEGER_FIELDS = new Set<keyof EmbeddingConfig>([
  'terminologyTopCount',
  'dataTrainingTopCount',
  'tableCount',
  'datasourceCount',
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
