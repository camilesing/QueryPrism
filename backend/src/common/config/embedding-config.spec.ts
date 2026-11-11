// Spec for the runtime embedding-config resolver: priority chain (saved
// SystemVariable > env > code default) and strict saved-value parsing.
import {
  EMBEDDING_PARAMETER_KEYS,
  parseEmbeddingParameter,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from './embedding-config';

const ENV_KEYS = [
  'EMBEDDING_ENABLED',
  'EMBEDDING_TERMINOLOGY_SIMILARITY',
  'EMBEDDING_TERMINOLOGY_TOP_COUNT',
  'EMBEDDING_DATA_TRAINING_SIMILARITY',
  'EMBEDDING_DATA_TRAINING_TOP_COUNT',
  'TABLE_EMBEDDING_ENABLED',
  'TABLE_EMBEDDING_COUNT',
  'TABLE_EMBEDDING_ALPHA',
  'TABLE_EMBEDDING_KEYWORD_ENABLED',
  'DS_EMBEDDING_COUNT',
  'EMBEDDING_THRESHOLD',
  'EMBEDDING_TOP_K',
  'CLARIFY_ENABLED',
  'CLARIFY_TABLE_THRESHOLD',
  'CLARIFY_MAX_SELECT',
  'CLARIFY_MAX_ROUNDS',
  'SEMANTIC_ENABLED',
  'SEMANTIC_MAX_TABLES',
  'SEMANTIC_ENUM_MAX_VALUES',
  'SEMANTIC_ENUM_SCAN_ROWS',
  'SEMANTIC_ENUM_COOLDOWN',
  'METRIC_ENABLED',
  'METRIC_MAX_DEFINITIONS',
  'NAMING_ENABLED',
];

function makePrisma(rows: { name: string; value: unknown }[] = []) {
  return {
    systemVariable: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
}

describe('parseEmbeddingParameter', () => {
  it('accepts real booleans and "true"/"false" strings only', () => {
    expect(parseEmbeddingParameter('enabled', true)).toBe(true);
    expect(parseEmbeddingParameter('enabled', 'false')).toBe(false);
    expect(() => parseEmbeddingParameter('enabled', 1)).toThrow();
    expect(() => parseEmbeddingParameter('enabled', 'yes')).toThrow();
    expect(() => parseEmbeddingParameter('enabled', null)).toThrow();
  });

  it('counts must be positive integer strings/numbers', () => {
    expect(parseEmbeddingParameter('tableCount', 10)).toBe(10);
    expect(parseEmbeddingParameter('tableCount', '3')).toBe(3);
    expect(() => parseEmbeddingParameter('tableCount', 0)).toThrow();
    expect(() => parseEmbeddingParameter('tableCount', -2)).toThrow();
    expect(() => parseEmbeddingParameter('tableCount', '2.5')).toThrow();
    expect(() => parseEmbeddingParameter('tableCount', true)).toThrow();
  });

  it('similarities/alpha must be finite numbers within [0,1]', () => {
    expect(parseEmbeddingParameter('tableAlpha', 0.4)).toBe(0.4);
    expect(parseEmbeddingParameter('tableAlpha', '0.7')).toBe(0.7);
    expect(parseEmbeddingParameter('tableAlpha', 0)).toBe(0);
    expect(parseEmbeddingParameter('tableAlpha', 1)).toBe(1);
    expect(() => parseEmbeddingParameter('tableAlpha', 1.2)).toThrow();
    expect(() => parseEmbeddingParameter('tableAlpha', -0.1)).toThrow();
    expect(() => parseEmbeddingParameter('tableAlpha', 'abc')).toThrow();
    expect(() => parseEmbeddingParameter('tableAlpha', true)).toThrow();
  });
});

describe('resolveEmbeddingConfig', () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ENV_KEYS) {
      ORIGINAL_ENV[k] = process.env[k];
      delete process.env[k];
    }
  });
  beforeEach(() => {
    // tests mutate env — reset to the beforeAll baseline between cases
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns code defaults when nothing is saved or set in env', async () => {
    const cfg = await resolveEmbeddingConfig(makePrisma() as never);
    expect(cfg).toEqual({
      enabled: true,
      terminologySimilarity: 0.4,
      terminologyTopCount: 5,
      dataTrainingSimilarity: 0.4,
      dataTrainingTopCount: 5,
      tableEnabled: true,
      tableCount: 10,
      tableAlpha: 0.4,
      keywordEnabled: true,
      datasourceCount: 10,
      clarifyEnabled: true,
      clarifyTableThreshold: 3,
      clarifyMaxSelect: 3,
      clarifyMaxRounds: 1,
      semanticEnabled: true,
      semanticMaxTables: 1,
      semanticEnumMaxValues: 50,
      semanticEnumScanRows: 10000,
      semanticEnumCooldown: 60,
      metricEnabled: true,
      metricMaxDefinitions: 5,
      metricSimilarityThreshold: 0.55,
      namingEnabled: true,
      quotaMaxRows: 1000,
      cacheEnabled: false,
      cacheTtlSeconds: 300,
    } satisfies EmbeddingConfig);
  });

  it('saved parameter rows override env defaults', async () => {
    process.env.TABLE_EMBEDDING_ALPHA = '0.8';
    const cfg = await resolveEmbeddingConfig(
      makePrisma([{ name: 'embedding.table_alpha', value: 0.2 }]) as never,
    );
    expect(cfg.tableAlpha).toBe(0.2);
  });

  it('env startup values override code defaults (upstream-named keys)', async () => {
    process.env.TABLE_EMBEDDING_COUNT = '15';
    process.env.EMBEDDING_TERMINOLOGY_SIMILARITY = '0.6';
    const cfg = await resolveEmbeddingConfig(makePrisma() as never);
    expect(cfg.tableCount).toBe(15);
    expect(cfg.terminologySimilarity).toBe(0.6);
  });

  it('legacy MCB keys feed the terminology pair when upstream keys absent', async () => {
    process.env.EMBEDDING_THRESHOLD = '0.55';
    process.env.EMBEDDING_TOP_K = '7';
    const cfg = await resolveEmbeddingConfig(makePrisma() as never);
    expect(cfg.terminologySimilarity).toBe(0.55);
    expect(cfg.terminologyTopCount).toBe(7);
    expect(cfg.dataTrainingSimilarity).toBe(0.55);
  });

  it('an invalid saved row throws instead of silently degrading', async () => {
    const rows = [{ name: 'embedding.table_alpha', value: 'banana' }];
    await expect(
      resolveEmbeddingConfig(makePrisma(rows) as never),
    ).rejects.toThrow('embedding.table_alpha');
  });

  it('clarify.* rows override env with strict parsing (boolean + positive ints)', async () => {
    process.env.CLARIFY_TABLE_THRESHOLD = '5';
    const cfg = await resolveEmbeddingConfig(
      makePrisma([
        { name: 'clarify.enabled', value: 'false' },
        { name: 'clarify.table_threshold', value: '4' },
        { name: 'clarify.max_select', value: 2 },
      ]) as never,
    );
    expect(cfg.clarifyEnabled).toBe(false);
    // saved row (4) beats env (5)
    expect(cfg.clarifyTableThreshold).toBe(4);
    expect(cfg.clarifyMaxSelect).toBe(2);
    // unsaved → env/default stands
    expect(cfg.clarifyMaxRounds).toBe(1);
    await expect(
      resolveEmbeddingConfig(
        makePrisma([{ name: 'clarify.max_rounds', value: 'zero' }]) as never,
      ),
    ).rejects.toThrow('clarify.max_rounds');
  });

  it('exposes exactly the twenty-six persisted keys', () => {
    expect(EMBEDDING_PARAMETER_KEYS).toHaveLength(26);
    expect(
      EMBEDDING_PARAMETER_KEYS.filter((k) => k.startsWith('embedding.')),
    ).toHaveLength(10);
    expect(
      EMBEDDING_PARAMETER_KEYS.filter((k) => k.startsWith('clarify.')),
    ).toHaveLength(4);
    expect(
      EMBEDDING_PARAMETER_KEYS.filter((k) => k.startsWith('semantic.')),
    ).toHaveLength(5);
    expect(
      EMBEDDING_PARAMETER_KEYS.filter(
        (k) => k.startsWith('metric.') || k.startsWith('naming.'),
      ),
    ).toHaveLength(4);
    // MetaDataImprove M7 query-cost keys
    expect(
      EMBEDDING_PARAMETER_KEYS.filter(
        (k) => k.startsWith('quota.') || k.startsWith('cache.'),
      ),
    ).toHaveLength(3);
  });

  it('metric.similarity_threshold defaults to 0.55 and parses strictly', async () => {
    const defaults = await resolveEmbeddingConfig(makePrisma([]) as never);
    expect(defaults.metricSimilarityThreshold).toBe(0.55);
    const saved = await resolveEmbeddingConfig(
      makePrisma([
        { name: 'metric.similarity_threshold', value: '0.72' },
      ]) as never,
    );
    expect(saved.metricSimilarityThreshold).toBe(0.72);
    await expect(
      resolveEmbeddingConfig(
        makePrisma([
          { name: 'metric.similarity_threshold', value: '1.5' },
        ]) as never,
      ),
    ).rejects.toThrow('metric.similarity_threshold');
  });

  it('metric.*/naming.* rows override env with strict parsing', async () => {
    process.env.METRIC_MAX_DEFINITIONS = '9';
    const cfg = await resolveEmbeddingConfig(
      makePrisma([
        { name: 'metric.enabled', value: 'false' },
        { name: 'metric.max_definitions', value: '3' },
      ]) as never,
    );
    // saved row (3) beats env (9)
    expect(cfg.metricEnabled).toBe(false);
    expect(cfg.metricMaxDefinitions).toBe(3);
    expect(cfg.namingEnabled).toBe(true);
    await expect(
      resolveEmbeddingConfig(
        makePrisma([{ name: 'metric.max_definitions', value: '0' }]) as never,
      ),
    ).rejects.toThrow('metric.max_definitions');
  });

  it('semantic.enum_* rows override env with strict positive-int parsing', async () => {
    process.env.SEMANTIC_ENUM_MAX_VALUES = '20';
    const cfg = await resolveEmbeddingConfig(
      makePrisma([
        { name: 'semantic.enum_max_values', value: '30' },
        { name: 'semantic.enum_scan_rows', value: 5000 },
      ]) as never,
    );
    // saved row (30) beats env (20); number values parse like strings
    expect(cfg.semanticEnumMaxValues).toBe(30);
    expect(cfg.semanticEnumScanRows).toBe(5000);
    // unsaved → env/default stands
    expect(cfg.semanticEnumCooldown).toBe(60);
    await expect(
      resolveEmbeddingConfig(
        makePrisma([{ name: 'semantic.enum_cooldown', value: '0' }]) as never,
      ),
    ).rejects.toThrow('semantic.enum_cooldown');
  });
});
