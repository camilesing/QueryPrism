// Spec for the runtime embedding-config resolver: priority chain (saved
// SystemVariable > env > code default) and strict saved-value parsing.
import {
  EMBEDDING_PARAMETER_KEYS,
  parseEmbeddingParameter,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from './embedding-config';

const ENV_KEYS = [
  'TABLE_EMBEDDING_ENABLED',
  'TABLE_EMBEDDING_ALPHA',
  'TABLE_EMBEDDING_TOP_K',
  'DS_EMBEDDING_COUNT',
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
  'JOIN_BRIDGE_MAX_HOPS',
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
    expect(parseEmbeddingParameter('tableEnabled', true)).toBe(true);
    expect(parseEmbeddingParameter('tableEnabled', 'false')).toBe(false);
    expect(() => parseEmbeddingParameter('tableEnabled', 1)).toThrow();
    expect(() => parseEmbeddingParameter('tableEnabled', 'yes')).toThrow();
    expect(() => parseEmbeddingParameter('tableEnabled', null)).toThrow();
  });

  it('counts must be positive integer strings/numbers', () => {
    expect(parseEmbeddingParameter('datasourceCount', 10)).toBe(10);
    expect(parseEmbeddingParameter('datasourceCount', '3')).toBe(3);
    expect(() => parseEmbeddingParameter('datasourceCount', 0)).toThrow();
    expect(() => parseEmbeddingParameter('datasourceCount', -2)).toThrow();
    expect(() => parseEmbeddingParameter('datasourceCount', '2.5')).toThrow();
    expect(() => parseEmbeddingParameter('datasourceCount', true)).toThrow();
  });

  it('alpha must be a finite number within [0,1]', () => {
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
      tableEnabled: true,
      tableAlpha: 0.4,
      tableTopK: 3,
      datasourceCount: 10,
      clarifyEnabled: true,
      clarifyTableThreshold: 3,
      clarifyMaxSelect: 3,
      clarifyMaxRounds: 1,
      semanticEnabled: true,
      semanticMaxTables: 3,
      semanticEnumMaxValues: 50,
      semanticEnumScanRows: 10000,
      semanticEnumCooldown: 60,
      metricEnabled: true,
      metricMaxDefinitions: 5,
      namingEnabled: true,
      joinBridgeMaxHops: 2,
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
    process.env.SEMANTIC_MAX_TABLES = '2';
    const cfg = await resolveEmbeddingConfig(makePrisma() as never);
    expect(cfg.semanticMaxTables).toBe(2);
  });

  it('the recall width and join-bridge hops are runtime parameters', async () => {
    // Keyword extraction and similarity thresholds stay deliberately NOT
    // parameters; the recall width and the bridge depth are.
    expect(EMBEDDING_PARAMETER_KEYS).not.toContain('embedding.keyword_enabled');
    expect(EMBEDDING_PARAMETER_KEYS).not.toContain(
      'metric.similarity_threshold',
    );
    expect(EMBEDDING_PARAMETER_KEYS).toContain('embedding.table_top_k');
    expect(EMBEDDING_PARAMETER_KEYS).toContain('join.bridge_max_hops');
    process.env.TABLE_EMBEDDING_TOP_K = '4';
    const cfg = await resolveEmbeddingConfig(
      makePrisma([
        { name: 'embedding.table_top_k', value: 5 },
        { name: 'join.bridge_max_hops', value: '3' },
      ]) as never,
    );
    // saved rows beat env; unsaved keys keep the env/default layer
    expect(cfg.tableTopK).toBe(5);
    expect(cfg.joinBridgeMaxHops).toBe(3);
    await expect(
      resolveEmbeddingConfig(
        makePrisma([{ name: 'join.bridge_max_hops', value: '0' }]) as never,
      ),
    ).rejects.toThrow('join.bridge_max_hops');
  });

  it('env startup values feed the new retrieval keys', async () => {
    process.env.TABLE_EMBEDDING_TOP_K = '5';
    process.env.JOIN_BRIDGE_MAX_HOPS = '3';
    const cfg = await resolveEmbeddingConfig(makePrisma() as never);
    expect(cfg.tableTopK).toBe(5);
    expect(cfg.joinBridgeMaxHops).toBe(3);
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

  it('exposes exactly the twenty persisted keys', () => {
    expect(EMBEDDING_PARAMETER_KEYS).toHaveLength(20);
    expect(
      EMBEDDING_PARAMETER_KEYS.filter((k) => k.startsWith('embedding.')),
    ).toHaveLength(4);
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
    ).toHaveLength(3);
    // MetaDataImprove M7 query-cost keys
    expect(
      EMBEDDING_PARAMETER_KEYS.filter(
        (k) => k.startsWith('quota.') || k.startsWith('cache.'),
      ),
    ).toHaveLength(3);
    // M3 join-bridge depth
    expect(
      EMBEDDING_PARAMETER_KEYS.filter((k) => k.startsWith('join.')),
    ).toHaveLength(1);
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
