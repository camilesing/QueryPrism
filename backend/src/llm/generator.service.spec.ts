// Spec for the six generators. LlmService is mocked to yield canned stream
// chunks; PromptService is real (loads the authored templates), so the spec
// also exercises end-to-end prompt rendering + JSON parsing.
import { GeneratorService, type LlmGenEvent } from './generator.service';
import { PromptService } from './prompt.service';
import type { LlmService, TokenUsage } from './llm.service';
import type { AiModelQuestion } from './ai-question';

/** Wrap a plain array as an AsyncIterable (object-form, no async generator —
 *  the `require-await` rule flags async generators that contain no `await`). */
function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<T>> =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false as const, value: items[i++] }),
      };
    },
  };
}

/** Build an LlmService mock whose stream() yields the given chunks. */
function mockLlm(
  chunks: Array<{ content?: string; reasoning?: string; usage?: TokenUsage }>,
): jest.Mocked<LlmService> {
  const items = chunks.map((c) => ({
    content: c.content ?? '',
    reasoning: c.reasoning ?? '',
    usage: c.usage,
  }));
  return {
    stream: jest.fn(() => asyncFrom(items)),
  } as unknown as jest.Mocked<LlmService>;
}

async function collect(g: AsyncGenerator<LlmGenEvent>): Promise<LlmGenEvent[]> {
  const out: LlmGenEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

function ctx(over: Partial<AiModelQuestion> = {}): AiModelQuestion {
  return {
    lang: 'zh-CN',
    queryprismName: 'QueryPrism',
    engine: 'MySQL',
    question: 'how many users?',
    schema: 'SCHEMA',
    sql: 'SELECT 1',
    sqlResult: '[{"a":1}]',
    datasourceList: [{ id: 1, name: 'db' }],
    ...over,
  };
}

function result(events: LlmGenEvent[]): unknown {
  const r = events.find((e) => e.type === 'result');
  return r && r.type === 'result' ? r.data : undefined;
}

describe('GeneratorService', () => {
  let prompt: PromptService;
  beforeAll(() => {
    prompt = new PromptService();
  });

  it('generateSql parses the streamed JSON into a SqlGenResult', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '```json\n{"success":true,"sql":"SELECT 1","tables":["t"],"chart-type":"bar","brief":"count"}\n```',
        },
      ]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));
    expect(result(events)).toEqual({
      success: true,
      sql: 'SELECT 1',
      tables: ['t'],
      chartType: 'bar',
      brief: 'count',
    });
  });

  it('keeps need_clarify table suggestions and renders candidate_tables', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '{"need_clarify":true,"reason":"needs the customer table","tables":["crm_customer"]}',
        },
      ]),
      prompt,
    );
    const events = await collect(
      gen.generateSql(ctx({ candidateTables: '- crm_customer: 客户信息' })),
    );
    const first = events[0] as {
      type: 'messages';
      messages: { type: string; content: string }[];
    };
    const human = first.messages.find((m) => m.type === 'human');
    expect(human?.content).toContain('- crm_customer: 客户信息');
    expect(result(events)).toMatchObject({
      needClarify: true,
      reason: 'needs the customer table',
      tables: ['crm_customer'],
    });
  });

  it('forwards the need_clarify contract instead of degrading to empty SQL', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '{"need_clarify":true,"reason":"the question needs the orders table"}',
        },
      ]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));
    expect(result(events)).toEqual({
      success: true,
      sql: '',
      tables: [],
      chartType: '',
      brief: '',
      needClarify: true,
      reason: 'the question needs the orders table',
    });
  });

  it('forwards reasoning deltas before the result', async () => {
    const gen = new GeneratorService(
      mockLlm([
        { reasoning: 'planning the query' },
        {
          content:
            '{"success":true,"sql":"SELECT 1","tables":[],"chart-type":"table","brief":"x"}',
        },
      ]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));
    const reasoning = events
      .filter((e) => e.type === 'reasoning')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(reasoning).toBe('planning the query');
  });

  it('generateSql yields null when no JSON is parseable', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: 'no json here' }]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));
    expect(result(events)).toBeNull();
  });

  it('§115(f)/(g): emits messages first, forwards usage, emits result last', async () => {
    // The messages event carries the pre-stream prompt list (system + human).
    // The usage event is forwarded from the final-chunk usage snapshot.
    // The result event is always last.
    const usage: TokenUsage = {
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    };
    const gen = new GeneratorService(
      mockLlm([
        { reasoning: 'planning' },
        {
          content:
            '{"success":true,"sql":"SELECT 1","tables":[],"chart-type":"table","brief":"x"}',
        },
        { content: '', usage }, // final chunk carries usage_metadata
      ]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));

    // messages is first
    expect(events[0].type).toBe('messages');
    const first = events[0] as {
      type: 'messages';
      messages: { type: string }[];
    };
    expect(first.messages.map((m) => m.type)).toEqual(['system', 'human']);
    // every serialized message has the queryprism_system flag
    expect(first.messages.every((m) => m.queryprism_system === false)).toBe(
      true,
    );

    // a usage event was forwarded
    const usageEv = events.find((e) => e.type === 'usage');
    expect(usageEv?.usage).toEqual(usage);

    // result is last
    expect(events[events.length - 1].type).toBe('result');
  });

  it('§115(f): no usage chunk → no usage event (result still last)', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '{"success":true,"sql":"SELECT 1","tables":[],"chart-type":"table","brief":"x"}',
        },
      ]),
      prompt,
    );
    const events = await collect(gen.generateSql(ctx()));
    expect(events.find((e) => e.type === 'usage')).toBeUndefined();
    expect(events[events.length - 1].type).toBe('result');
  });

  it('generateAnalysis accumulates free text as the analysis', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: 'There are ' }, { content: '5 users.' }]),
      prompt,
    );
    const events = await collect(gen.generateAnalysis(ctx()));
    expect(result(events)).toEqual({ analysis: 'There are 5 users.' });
    // content deltas forwarded
    const content = events
      .filter((e) => e.type === 'content')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(content).toBe('There are 5 users.');
  });

  it('generateChart parses the chart config', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: '{"chartType":"bar","xField":"a","yField":"b"}' }]),
      prompt,
    );
    const data = result(await collect(gen.generateChart(ctx())));
    expect(data).toEqual({
      chartType: 'bar',
      config: { xField: 'a', yField: 'b' },
    });
  });

  it('generatePredict parses predict + predict_data', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '{"predict":"rising","predict_data":[{"label":"q1","value":10}]}',
        },
      ]),
      prompt,
    );
    expect(result(await collect(gen.generatePredict(ctx())))).toEqual({
      predict: 'rising',
      predictData: [{ label: 'q1', value: 10 }],
    });
  });

  it('generateGuessQuestion parses a questions array', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: '{"questions":["a","b","c"]}' }]),
      prompt,
    );
    expect(result(await collect(gen.generateGuessQuestion(ctx())))).toEqual({
      questions: ['a', 'b', 'c'],
    });
  });

  it('selectDatasource parses the chosen datasource id', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: '{"datasource_id":3}' }]),
      prompt,
    );
    expect(result(await collect(gen.selectDatasource(ctx())))).toEqual({
      datasourceId: 3,
    });
  });

  it('generateFilter parses the merged SQL (§111)', async () => {
    const gen = new GeneratorService(
      mockLlm([
        {
          content:
            '{"success":true,"sql":"SELECT * FROM `users` WHERE `age` > 18"}',
        },
      ]),
      prompt,
    );
    expect(
      result(
        await collect(
          gen.generateFilter(
            ctx({
              sql: 'SELECT * FROM users',
              filter: '[{"table":"users","filter":"(`age` > \'\'18\'\')"}]',
            }),
          ),
        ),
      ),
    ).toEqual({
      success: true,
      sql: 'SELECT * FROM `users` WHERE `age` > 18',
    });
  });

  it('generateFilter yields null when no JSON is parseable (§111)', async () => {
    const gen = new GeneratorService(
      mockLlm([{ content: 'I cannot comply' }]),
      prompt,
    );
    expect(
      result(await collect(gen.generateFilter(ctx({ sql: 'SELECT 1' })))),
    ).toBeNull();
  });
});

describe('GeneratorService parser arm sweep', () => {
  let prompt: PromptService;
  beforeAll(() => {
    prompt = new PromptService();
  });

  const run = async (
    chunks: Array<{ content?: string; reasoning?: string }>,
    gen: (g: GeneratorService) => AsyncGenerator<LlmGenEvent>,
  ) => collect(gen(new GeneratorService(mockLlm(chunks), prompt)));

  const messagesEvent = (events: LlmGenEvent[]) =>
    (events[0] as { messages: { type: string; content: string }[] }).messages;

  // ---- extractKeywords (free TEXT, trimmed, sentinels pass through) --------
  it('extractKeywords returns the trimmed raw text as keywords', async () => {
    const events = await run([{ content: '  sale, revenue , 2024  ' }], (g) =>
      g.extractKeywords(ctx()),
    );
    expect(result(events)).toEqual({ keywords: 'sale, revenue , 2024' });
  });

  it('extractKeywords forwards the ERROR:NOT_DATA_QUERY sentinel untouched', async () => {
    const events = await run([{ content: 'ERROR:NOT_DATA_QUERY' }], (g) =>
      g.extractKeywords(ctx()),
    );
    expect(result(events)).toEqual({ keywords: 'ERROR:NOT_DATA_QUERY' });
  });

  // ---- message building ----------------------------------------------------
  it('injects history rounds as AIMessage/HumanMessage between system and task', async () => {
    const events = await run([{ content: '{"questions":[]}' }], (g) =>
      g.generateGuessQuestion(
        ctx({
          history: [
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
          ],
        }),
      ),
    );
    expect(messagesEvent(events).map((m) => m.type)).toEqual([
      'system',
      'human',
      'ai',
      'human',
    ]);
  });

  it('serializes multimodal (non-string) message content as JSON', async () => {
    const events = await run([{ content: '{"questions":[]}' }], (g) =>
      g.generateGuessQuestion(
        ctx({
          history: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'blocks' }],
            } as never,
          ],
        }),
      ),
    );
    const human = messagesEvent(events).find((m) => m.type === 'human');
    expect(human?.content).toContain('{"type":"text","text":"blocks"}');
  });

  it('renders an empty datasource list section when none is provided', async () => {
    const events = await run([{ content: '{"datasource_id":1}' }], (g) =>
      g.selectDatasource({ ...ctx(), datasourceList: undefined }),
    );
    // still parses; the {datasource_list} placeholder rendered as empty text
    expect(result(events)).toEqual({ datasourceId: 1 });
  });

  it('appends each datasource description when present', async () => {
    const events = await run([{ content: '{"datasource_id":2}' }], (g) =>
      g.selectDatasource(
        ctx({
          datasourceList: [
            { id: 1, name: 'plain' },
            { id: 2, name: 'rich', description: 'sales database' },
          ],
        }),
      ),
    );
    const human = messagesEvent(events).find((m) => m.type === 'human');
    expect(human?.content).toContain('1. plain\n2. rich - sales database');
    expect(result(events)).toEqual({ datasourceId: 2 });
  });

  // ---- parseSqlResult ------------------------------------------------------
  it('need_clarify without a reason leaves reason undefined (not empty string)', async () => {
    const events = await run(
      [{ content: '{"need_clarify":true,"tables":["t"]}' }],
      (g) => g.generateSql(ctx()),
    );
    expect(result(events)).toEqual({
      success: true,
      sql: '',
      tables: ['t'],
      chartType: '',
      brief: '',
      needClarify: true,
    });
  });

  it('accepts camelCase needClarify and coerces numeric sql/brief to strings', async () => {
    const events = await run(
      [{ content: '{"needClarify":true,"reason":"r","sql":42,"brief":3}' }],
      (g) => g.generateSql(ctx()),
    );
    expect(result(events)).toMatchObject({
      needClarify: true,
      reason: 'r',
      sql: '42',
      brief: '3',
    });
  });

  it('accepts camelCase chartType and sql/table aliases', async () => {
    const events = await run(
      [
        {
          content:
            '{"success":true,"sql":"SELECT 1","tables":"not-an-array","chartType":"line","brief":true}',
        },
      ],
      (g) => g.generateSql(ctx()),
    );
    expect(result(events)).toEqual({
      success: true,
      sql: 'SELECT 1',
      tables: [],
      chartType: 'line',
      brief: 'true',
    });
  });

  // ---- parseChartResult ------------------------------------------------------
  it('generateChart accepts the snake_case chart-type key', async () => {
    const events = await run(
      [{ content: '{"chart-type":"pie","xField":"a"}' }],
      (g) => g.generateChart(ctx()),
    );
    expect(result(events)).toEqual({
      chartType: 'pie',
      config: { xField: 'a' },
    });
  });

  it('generateChart yields null when the chart type is missing', async () => {
    const events = await run(
      [{ content: '{"xField":"a","yField":"b"}' }],
      (g) => g.generateChart(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  it('generateChart yields null when no JSON is parseable', async () => {
    const events = await run(
      [{ content: 'The chart should be a bar chart.' }],
      (g) => g.generateChart(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  // ---- parsePredictResult ----------------------------------------------------
  it('generatePredict accepts camelCase predictData', async () => {
    const events = await run(
      [{ content: '{"predict":"stable","predictData":[{"label":"q2"}]}' }],
      (g) => g.generatePredict(ctx()),
    );
    expect(result(events)).toEqual({
      predict: 'stable',
      predictData: [{ label: 'q2' }],
    });
  });

  it('generatePredict defaults predictData to null and stringifies numeric predict', async () => {
    const events = await run([{ content: '{"predict":7}' }], (g) =>
      g.generatePredict(ctx()),
    );
    expect(result(events)).toEqual({ predict: '7', predictData: null });
  });

  it('generatePredict yields null when no JSON is parseable', async () => {
    const events = await run([{ content: 'no prediction possible' }], (g) =>
      g.generatePredict(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  // ---- parseGuessResult ------------------------------------------------------
  it('generateGuessQuestion accepts a top-level questions array', async () => {
    const events = await run([{ content: '["q1","q2"]' }], (g) =>
      g.generateGuessQuestion(ctx()),
    );
    expect(result(events)).toEqual({ questions: ['q1', 'q2'] });
  });

  it('generateGuessQuestion yields null when questions is not an array', async () => {
    const events = await run(
      [{ content: '{"questions":"not-an-array"}' }],
      (g) => g.generateGuessQuestion(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  it('generateGuessQuestion yields null when no JSON is parseable', async () => {
    const events = await run([{ content: 'what would you ask?' }], (g) =>
      g.generateGuessQuestion(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  // ---- parseSelectDsResult ---------------------------------------------------
  it('selectDatasource accepts camelCase datasourceId', async () => {
    const events = await run([{ content: '{"datasourceId":5}' }], (g) =>
      g.selectDatasource(ctx()),
    );
    expect(result(events)).toEqual({ datasourceId: 5 });
  });

  it('selectDatasource yields null when the id is missing', async () => {
    const events = await run([{ content: '{"other":1}' }], (g) =>
      g.selectDatasource(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  it('selectDatasource yields null when the id is not numeric', async () => {
    const events = await run([{ content: '{"datasource_id":"abc"}' }], (g) =>
      g.selectDatasource(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  it('selectDatasource yields null when no JSON is parseable', async () => {
    const events = await run([{ content: 'use db two' }], (g) =>
      g.selectDatasource(ctx()),
    );
    expect(result(events)).toBeNull();
  });

  // ---- parseFilterResult -----------------------------------------------------
  it('generateFilter defaults success to true and drops empty message', async () => {
    const events = await run([{ content: '{"sql":"SELECT 1"}' }], (g) =>
      g.generateFilter(ctx({ sql: 'SELECT 1' })),
    );
    expect(result(events)).toEqual({ success: true, sql: 'SELECT 1' });
  });

  it('generateFilter carries a failure message through', async () => {
    const events = await run(
      [{ content: '{"success":false,"message":"cannot merge"}' }],
      (g) => g.generateFilter(ctx({ sql: 'SELECT 1' })),
    );
    expect(result(events)).toEqual({
      success: false,
      sql: '',
      message: 'cannot merge',
    });
  });
});
