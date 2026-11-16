// Spec for the AiQuestionService context assembly. The downstream services
// (datasource / terminology / data-training) are mocked; recall of
// terminology / data-training reads oid from RequestContext, so each call is
// wrapped in requestContextStorage.run.
import { requestContextStorage } from '../common/context/request-context';
import { AiQuestionService } from './ai-question.service';
import type { DatasourceService } from '../datasource/datasource.service';
import type { TerminologyService } from '../terminology/terminology.service';
import type { DataTrainingService } from '../data-training/data-training.service';
import type { CustomPromptService } from '../custom-prompt/custom-prompt.service';
import type { ConfigService } from '@nestjs/config';

/** DatasourceService with the three methods AiQuestionService calls typed as
 *  plain jest.Mock (jest.Mocked is shallow and leaves methods as their real
 *  types, which trips unbound-method when referenced in expect(...)). */
type DatasourceServiceMock = Omit<
  DatasourceService,
  'getMSchema' | 'findOne' | 'previewTable'
> & {
  getMSchema: jest.Mock;
  findOne: jest.Mock;
  previewTable: jest.Mock;
};

function makeService(opts?: {
  /** config.get('chat.sampleDataEnabled') — env-default override. */
  envDefault?: boolean;
  /** SystemVariable row for chat.sample_data_enabled (null = not saved). */
  savedRow?: unknown;
}) {
  const datasourceService = {
    getMSchema: jest.fn().mockResolvedValue('MS-SCHEMA'),
    findOne: jest.fn().mockResolvedValue({
      id: 1,
      tables: [
        { tableName: 'users', checked: true },
        { tableName: 'orders', checked: true },
        { tableName: 'hidden', checked: false },
      ],
    }),
    previewTable: jest.fn().mockImplementation(() => ({
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'sample' }],
    })),
  } as unknown as DatasourceServiceMock;

  const terminologyService = {
    getTerminologyTemplate: jest.fn().mockResolvedValue('<terminologies/>'),
  } as unknown as jest.Mocked<TerminologyService>;

  const dataTrainingService = {
    getDataTrainingTemplate: jest.fn().mockResolvedValue('<data_training/>'),
  } as unknown as jest.Mocked<DataTrainingService>;

  const customPromptService = {
    findCustomPrompts: jest.fn().mockResolvedValue({
      customPromptText: 'be concise',
      promptList: [],
    }),
  } as unknown as jest.Mocked<CustomPromptService>;

  const config = {
    get: jest.fn((k: string) => {
      if (k === 'chat.queryprismName') return 'QueryPrism';
      if (k === 'chat.sampleDataEnabled') return opts?.envDefault ?? true;
      return undefined;
    }),
  } as unknown as jest.Mocked<ConfigService>;

  const prisma = {
    systemVariable: {
      findFirst: jest.fn().mockResolvedValue(opts?.savedRow ?? null),
    },
  };

  const svc = new AiQuestionService(
    datasourceService,
    terminologyService,
    dataTrainingService,
    customPromptService,
    config,
    prisma as never,
  );
  return {
    svc,
    datasourceService,
    terminologyService,
    dataTrainingService,
    customPromptService,
    prisma,
  };
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid: 1, language: 'zh-CN' } },
    fn,
  );
}

describe('AiQuestionService', () => {
  it('assembles schema, sample data, terminology and training into the context', async () => {
    const { svc, datasourceService } = makeService();
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'how many active users?',
        datasourceId: 1,
        engine: 'MySQL',
      }),
    );
    expect(ctx.schema).toBe('MS-SCHEMA');
    expect(ctx.terminologies).toBe('<terminologies/>');
    expect(ctx.dataTraining).toBe('<data_training/>');
    // both checked tables sampled; the hidden one skipped
    expect(ctx.sampleData).toContain('Table: users');
    expect(ctx.sampleData).toContain('Table: orders');
    expect(ctx.sampleData).not.toContain('hidden');
    expect(datasourceService.previewTable).toHaveBeenCalledTimes(2);
    expect(ctx.queryprismName).toBe('QueryPrism');
    expect(ctx.lang).toBe('zh-CN');
    expect(ctx.engine).toBe('MySQL');
  });

  it('skips the sample-data gather when chat.sample_data_enabled is false (0b5588b5)', async () => {
    const { svc, datasourceService } = makeService({
      savedRow: { value: 'false' },
    });
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'how many active users?',
        datasourceId: 1,
        engine: 'MySQL',
      }),
    );
    expect(ctx.sampleData).toBe('');
    expect(datasourceService.findOne).not.toHaveBeenCalled();
    expect(datasourceService.previewTable).not.toHaveBeenCalled();
    // the rest of the context is unaffected
    expect(ctx.schema).toBe('MS-SCHEMA');
    expect(ctx.terminologies).toBe('<terminologies/>');
  });

  it('falls back to the env default when no parameter row is saved', async () => {
    const { svc, datasourceService } = makeService({ envDefault: false });
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'MySQL',
      }),
    );
    expect(ctx.sampleData).toBe('');
    expect(datasourceService.previewTable).not.toHaveBeenCalled();
  });

  it('a saved true parameter overrides a disabled env default', async () => {
    const { svc, datasourceService } = makeService({
      envDefault: false,
      savedRow: { value: true },
    });
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'MySQL',
      }),
    );
    expect(ctx.sampleData).toContain('Table: users');
    expect(datasourceService.previewTable).toHaveBeenCalled();
  });

  it('attaches sql + sqlResult for the result-phase context', async () => {
    const { svc } = makeService();
    const ctx = await run(() =>
      svc.buildForResult({
        question: 'show sales',
        datasourceId: 1,
        engine: 'PostgreSQL',
        sql: 'SELECT 1',
        sqlResult: '[{"a":1}]',
      }),
    );
    expect(ctx.sql).toBe('SELECT 1');
    expect(ctx.sqlResult).toBe('[{"a":1}]');
    expect(ctx.schema).toBe('MS-SCHEMA');
  });

  it('threads tableIds through to getMSchema (embedding pre-filter narrowing)', async () => {
    const { svc, datasourceService } = makeService();
    await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'MySQL',
        tableIds: [10, 20],
      }),
    );
    expect(datasourceService.getMSchema).toHaveBeenCalledWith(
      1,
      [10, 20],
      undefined,
    );
  });

  it('threads tableIds through buildForResult to getMSchema', async () => {
    const { svc, datasourceService } = makeService();
    await run(() =>
      svc.buildForResult({
        question: 'q',
        datasourceId: 1,
        engine: 'MySQL',
        sql: 'SELECT 1',
        sqlResult: '[]',
        tableIds: [5],
      }),
    );
    expect(datasourceService.getMSchema).toHaveBeenCalledWith(
      1,
      [5],
      undefined,
    );
  });

  it('calls getMSchema with undefined tableIds when not provided', async () => {
    const { svc, datasourceService } = makeService();
    await run(() =>
      svc.buildSqlContext({ question: 'q', datasourceId: 1, engine: 'MySQL' }),
    );
    expect(datasourceService.getMSchema).toHaveBeenCalledWith(
      1,
      undefined,
      undefined,
    );
  });

  it('builds the select-datasource context with the option list', () => {
    const { svc } = makeService();
    const ctx = run(() =>
      Promise.resolve(
        svc.buildForSelectDatasource({
          question: 'sales trend?',
          datasources: [
            { id: 1, name: 'sales_db' },
            { id: 2, name: 'users_db', description: 'user data' },
          ],
        }),
      ),
    );
    return ctx.then((c) => {
      expect(c.datasourceList).toHaveLength(2);
      expect(c.datasourceList?.[1].description).toBe('user data');
      expect(c.question).toBe('sales trend?');
    });
  });

  it('skips tables that fail to sample without breaking the context', async () => {
    const { svc, datasourceService } = makeService();
    datasourceService.previewTable.mockImplementation(
      (_id: number, table: string) =>
        table === 'orders'
          ? Promise.reject(new Error('dropped'))
          : Promise.resolve({ columns: ['id'], rows: [] }),
    );
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'SQLite',
      }),
    );
    expect(ctx.sampleData).toContain('users');
    expect(ctx.sampleData).not.toContain('orders');
  });

  it('falls back to en when no user context is present', () => {
    const { svc } = makeService();
    // No requestContextStorage.run — runs outside any scope.
    const ctx = svc.buildForSelectDatasource({
      question: 'q',
      datasources: [],
    });
    expect(ctx.lang).toBe('en');
  });

  // --- per-turn lang override (question-language detection) -------------
  // The chat pipeline passes the question's detected language; the profile
  // language (zh-CN in run()) is only the fallback when lang is omitted.

  it('uses the per-turn lang override over the profile language in buildSqlContext', async () => {
    const { svc } = makeService();
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'show sales by region',
        datasourceId: 1,
        engine: 'MySQL',
        lang: 'en',
      }),
    );
    expect(ctx.lang).toBe('en');
  });

  it('threads the per-turn lang through buildForResult', async () => {
    const { svc } = makeService();
    const ctx = await run(() =>
      svc.buildForResult({
        question: 'show sales by region',
        datasourceId: 1,
        engine: 'MySQL',
        sql: 'SELECT 1',
        sqlResult: '[]',
        lang: 'en',
      }),
    );
    expect(ctx.lang).toBe('en');
  });

  it('buildForKeywords honors the lang override and falls back without it', () => {
    const { svc } = makeService();
    const overridden = svc.buildForKeywords({
      question: 'q',
      engine: 'MySQL',
      lang: 'en',
    });
    expect(overridden.lang).toBe('en');
    const fallback = svc.buildForKeywords({ question: 'q', engine: 'MySQL' });
    // Outside run() there is no user — the default fallback is now 'en'.
    expect(fallback.lang).toBe('en');
  });

  it('buildFilterContext honors the lang override', () => {
    const { svc } = makeService();
    const ctx = svc.buildFilterContext({
      engine: 'MySQL',
      sql: 'SELECT 1',
      filter: '[]',
      lang: 'en',
    });
    expect(ctx.lang).toBe('en');
  });

  it('buildForSelectDatasource honors the lang override', () => {
    const { svc } = makeService();
    const ctx = svc.buildForSelectDatasource({
      question: 'q',
      datasources: [],
      lang: 'en',
    });
    expect(ctx.lang).toBe('en');
  });

  // --- §110 runtime custom_prompt injection --------------------------
  // buildSqlContext calls CustomPromptService.findCustomPrompts only when
  // customPromptType is passed (GENERATE_SQL/ANALYSIS/PREDICT_DATA); the
  // matched body flows into the system prompt via ctx.customPrompt.

  it('§110: buildSqlContext with customPromptType looks up + injects the custom-prompt body', async () => {
    const { svc, customPromptService } = makeService();
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'SQLite',
        customPromptType: 'GENERATE_SQL',
      }),
    );
    expect(customPromptService.findCustomPrompts).toHaveBeenCalledWith(
      'GENERATE_SQL',
      1,
      1,
    );
    expect(ctx.customPrompt).toBe('be concise');
  });

  it('§110: buildSqlContext without customPromptType skips the lookup (no injection)', async () => {
    const { svc, customPromptService } = makeService();
    const ctx = await run(() =>
      svc.buildSqlContext({
        question: 'q',
        datasourceId: 1,
        engine: 'SQLite',
      }),
    );
    expect(customPromptService.findCustomPrompts).not.toHaveBeenCalled();
    expect(ctx.customPrompt).toBe('');
  });

  it('§110: buildForResult threads customPromptType through (analysis/predict get the right type)', async () => {
    const { svc, customPromptService } = makeService();
    const ctx = await run(() =>
      svc.buildForResult({
        question: 'q',
        datasourceId: 1,
        engine: 'SQLite',
        sql: 'SELECT 1',
        sqlResult: '[[]]',
        customPromptType: 'ANALYSIS',
      }),
    );
    expect(customPromptService.findCustomPrompts).toHaveBeenCalledWith(
      'ANALYSIS',
      1,
      1,
    );
    expect(ctx.customPrompt).toBe('be concise');
    // buildForResult still attaches sql + sqlResult on top of the base ctx.
    expect(ctx.sql).toBe('SELECT 1');
    expect(ctx.sqlResult).toBe('[[]]');
  });
});

// ─────────────── tail-sweep: residual fallback arms ───────────────

describe('AiQuestionService (tail-sweep)', () => {
  it('§110: customPromptType outside a request context falls back to oid 0', async () => {
    const { svc, customPromptService } = makeService();
    // NOT wrapped in run() — RequestContext.getUser() is undefined
    const ctx = await svc.buildSqlContext({
      question: 'q',
      datasourceId: 1,
      engine: 'MySQL',
      customPromptType: 'GENERATE_SQL',
    });
    expect(customPromptService.findCustomPrompts).toHaveBeenCalledWith(
      'GENERATE_SQL',
      0,
      1,
    );
    expect(ctx.customPrompt).toBe('be concise');
  });

  it('buildFilterContext falls back to the profile language when lang is omitted', async () => {
    const { svc } = makeService();
    const ctx = await run(() =>
      Promise.resolve(
        svc.buildFilterContext({
          engine: 'MySQL',
          sql: 'SELECT 1',
          filter: '[]',
        }),
      ),
    );
    expect(ctx.lang).toBe('zh-CN');
  });

  it('an undefined env default with no saved row enables sample data (?? true)', async () => {
    const { svc, datasourceService } = makeService({
      envDefault: undefined,
      savedRow: null,
    });
    const ctx = await run(() =>
      svc.buildSqlContext({ question: 'q', datasourceId: 1, engine: 'MySQL' }),
    );
    expect(ctx.sampleData).toContain('Table: users');
    expect(datasourceService.previewTable).toHaveBeenCalled();
  });

  it('stringifies a non-Error sample failure in the skip warning', async () => {
    const { svc, datasourceService } = makeService();
    datasourceService.previewTable.mockImplementation(() =>
      // Intentionally rejects with a non-Error: the skip warning must stringify it.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('plain preview failure'),
    );
    const ctx = await run(() =>
      svc.buildSqlContext({ question: 'q', datasourceId: 1, engine: 'MySQL' }),
    );
    // every table skipped, but the context still resolves
    expect(ctx.sampleData).toBe('');
  });

  it('defaults queryprismName to QueryPrism when config omits it', async () => {
    const { svc } = makeService();
    // swap the config answer for one that returns undefined everywhere
    const internals = svc as unknown as { config: { get: jest.Mock } };
    internals.config.get.mockImplementation(() => undefined);
    const ctx = await run(() =>
      svc.buildSqlContext({ question: 'q', datasourceId: 1, engine: 'MySQL' }),
    );
    expect(ctx.queryprismName).toBe('QueryPrism');
    // chat.sampleDataEnabled also undefined here → sample data still on
    expect(ctx.sampleData).toContain('Table: users');
  });
});
