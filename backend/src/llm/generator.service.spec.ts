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
