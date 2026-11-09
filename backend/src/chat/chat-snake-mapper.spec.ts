// chat-snake-mapper spec — the frontend
// reads ChatInfo/ChatRecord/ChatLogHistory in snake_case. We use
// explicit per-service mappers (NOT a global camelToSnake interceptor) so
// nested Json blobs (chart config, sqlExecResult, predictData) pass through
// verbatim instead of being mangled. This spec pins the field names + the
// Json-passthrough guarantee + the with_data data-population rule.
import type { Chat, ChatLog, ChatRecord, Datasource } from '@prisma/client';
import {
  toChatInfoSnake,
  toChatLogHistoryItemSnake,
  toChatLogHistorySnake,
  toChatRecordSnake,
} from './chat-snake-mapper';

// Minimal factory helpers — the mapper is structural, so plain objects typed
// against the Prisma model are enough (no DB).
function makeChat(over: Partial<Chat> = {}): Chat {
  return {
    id: 1,
    oid: 1,
    datasourceId: 5,
    datasource: undefined,
    engineType: 'SQLite',
    title: '新对话',
    brief: '用户数',
    origin: 0,
    recommendedQuestion: null,
    chatType: null,
    dsType: null,
    recommendedGenerate: null,
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    updatedAt: new Date('2026-07-25T00:01:00.000Z'),
    records: [],
    ...over,
  } as unknown as Chat;
}

function makeRecord(over: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 10,
    chatId: 1,
    oid: 1,
    question: '各分类销量',
    sqlAnswer: '查询分类销量',
    sql: 'SELECT category, SUM(value) FROM sales GROUP BY category',
    sqlExecResult: { columns: ['category', 'value'], rows: [['a', 10]] },
    data: null,
    chartAnswer: '柱状图展示',
    chart: { xField: 'category', yField: 'value' },
    chartType: 'bar',
    brief: '销量',
    analysis: 'A 类最高',
    predict: '预测上升',
    predictData: { series: [1, 2, 3] },
    recommendedQuestion: ['下个问题?'],
    analysisRecordId: null,
    predictRecordId: null,
    regenerateRecordId: null,
    finish: true,
    error: null,
    clarify: null,
    clarifyAnswer: null,
    clarifyStatus: null,
    analysisThinking: '思考过程',
    predictContent: '预测正文',
    runTime: 3,
    firstChat: true,
    duration: 12,
    totalTokens: 480,
    createdAt: new Date('2026-07-25T00:00:10.000Z'),
    updatedAt: new Date('2026-07-25T00:00:30.000Z'),
    logs: [],
    ...over,
  } as unknown as ChatRecord;
}

function makeLog(over: Partial<ChatLog> = {}): ChatLog {
  return {
    id: 100,
    chatRecordId: 10,
    chatRecord: undefined,
    messages: [{ role: 'user', content: 'q' }],
    reasoningContent: 'r',
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    operate: 'GENERATE_SQL',
    localOperation: false,
    error: false,
    startedAt: new Date('2026-07-25T00:00:10.000Z'),
    endedAt: new Date('2026-07-25T00:00:13.000Z'),
    ...over,
  } as unknown as ChatLog;
}

describe('toChatRecordSnake', () => {
  it('maps every scalar field to snake_case + ISO timestamps', () => {
    const out = toChatRecordSnake(makeRecord(), { chat: makeChat() });
    expect(out).toMatchObject({
      id: 10,
      chat_id: 1,
      create_time: '2026-07-25T00:00:10.000Z',
      finish_time: '2026-07-25T00:00:30.000Z',
      question: '各分类销量',
      sql_answer: '查询分类销量',
      sql: 'SELECT category, SUM(value) FROM sales GROUP BY category',
      datasource: 5,
      chart_answer: '柱状图展示',
      analysis: 'A 类最高',
      analysis_thinking: '思考过程',
      predict: '预测上升',
      predict_content: '预测正文',
      predict_data: { series: [1, 2, 3] },
      finish: true,
      error: null,
      run_time: 3,
      first_chat: true,
      recommended_question: ['下个问题?'],
      analysis_record_id: null,
      predict_record_id: null,
      regenerate_record_id: null,
      duration: 12,
      total_tokens: 480,
    });
    // chartType must NOT leak into the record payload (it lives on the
    // chat-level config, not per-record) — only `chart` (the config blob).
    expect(out).not.toHaveProperty('chart_type');
    expect(out).not.toHaveProperty('chartType');
  });

  it('serializes the chart Json blob to a string without mangling inner keys', () => {
    const config = {
      type: 'line',
      title: '订单趋势',
      axis: { x: { name: '订单日期', value: '订单日期' } },
    };
    const out = toChatRecordSnake(makeRecord({ chart: config }));
    // The frontend calls JSON.parse(record.chart) — it must be a string.
    expect(typeof out.chart).toBe('string');
    expect(JSON.parse(out.chart!)).toEqual(config);
  });

  it('keeps a legacy chart string as-is and maps null chart to null', () => {
    const legacy = '{"type":"table","columns":[]}';
    expect(toChatRecordSnake(makeRecord({ chart: legacy })).chart).toBe(legacy);
    expect(toChatRecordSnake(makeRecord({ chart: null })).chart).toBeNull();
  });

  it('rebuilds a legacy field-mapping chart into the chart object', () => {
    // Rows written before the chart-object contract stored only the mapping.
    const out = toChatRecordSnake(makeRecord());
    expect(JSON.parse(out.chart!)).toEqual({
      type: 'bar',
      title: '',
      axis: {
        x: { name: 'category', value: 'category' },
        y: [{ name: 'value', value: 'value' }],
      },
    });
  });

  it('leaves data null when withData is false (frontend GETs rows separately)', () => {
    const out = toChatRecordSnake(makeRecord(), { withData: false });
    expect(out.data).toBeNull();
  });

  it('populates data with sqlExecResult when withData is true (with_data route)', () => {
    const qr = { columns: ['category', 'value'], rows: [['a', 10]] };
    const out = toChatRecordSnake(makeRecord({ sqlExecResult: qr }), {
      withData: true,
    });
    expect(out.data).toEqual(qr);
  });

  it('nulls datasource when no chat is provided', () => {
    const out = toChatRecordSnake(makeRecord());
    expect(out.datasource).toBeNull();
  });

  it('passes the clarify round through verbatim (snake keys preserved)', () => {
    // MetaDataImprove M1: clarify/clarify_answer are Json blobs whose inner
    // keys are already snake_case on the wire — they must pass by reference
    // (like recommended_question), never key-mangled.
    const clarify = {
      question: '统计一下整体情况',
      candidates: [{ table_id: 1, table_name: 'orders', comment: '订单表' }],
      max_select: 3,
    };
    const clarifyAnswer = { table_ids: [1], table_names: ['orders'] };
    const out = toChatRecordSnake(
      makeRecord({
        clarify,
        clarifyAnswer,
        clarifyStatus: 'pending',
        finish: false,
      }),
    );
    expect(out.clarify).toBe(clarify);
    expect(out.clarify_answer).toBe(clarifyAnswer);
    expect(out.clarify_status).toBe('pending');
  });
});

describe('toChatInfoSnake', () => {
  it('maps chat scalars + datasource_name + datasource_exists + records', () => {
    const ds = { id: 5, name: 'main-db' } as unknown as Datasource;
    const rec = toChatRecordSnake(makeRecord());
    const out = toChatInfoSnake(makeChat(), {
      datasource: ds,
      records: [rec],
    });
    expect(out).toMatchObject({
      id: 1,
      create_time: '2026-07-25T00:00:00.000Z',
      create_by: null,
      brief: '用户数',
      chat_type: null,
      datasource: 5,
      engine_type: 'SQLite',
      ds_type: null,
      datasource_name: 'main-db',
      datasource_exists: true,
      recommended_question: null,
      recommended_generate: null,
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0].id).toBe(10);
  });

  it('reports datasource_exists=false when the datasource was deleted', () => {
    const out = toChatInfoSnake(makeChat({ datasourceId: 5 }), {
      datasource: undefined,
    });
    expect(out.datasource_exists).toBe(false);
    expect(out.datasource_name).toBeNull();
  });

  it('defaults records to [] when none provided', () => {
    const out = toChatInfoSnake(makeChat());
    expect(out.records).toEqual([]);
  });

  it('passes recommendedQuestion Json blob through verbatim', () => {
    const rq = ['q1', 'q2'];
    const out = toChatInfoSnake(makeChat({ recommendedQuestion: rq }));
    expect(out.recommended_question).toEqual(rq);
  });
});

describe('toChatLogHistorySnake', () => {
  it('aggregates start/finish/duration/tokens across steps + maps each log', () => {
    const logs = [
      makeLog({
        startedAt: new Date('2026-07-25T00:00:10.000Z'),
        endedAt: new Date('2026-07-25T00:00:13.000Z'),
        tokenUsage: { totalTokens: 15 },
        operate: 'GENERATE_SQL',
        error: false,
      }),
      makeLog({
        id: 101,
        startedAt: new Date('2026-07-25T00:00:20.000Z'),
        endedAt: new Date('2026-07-25T00:00:25.000Z'),
        tokenUsage: { totalTokens: 20 },
        operate: 'GENERATE_CHART',
        error: false,
      }),
    ];
    const out = toChatLogHistorySnake(makeRecord(), logs);
    expect(out.start_time).toBe('2026-07-25T00:00:10.000Z');
    expect(out.finish_time).toBe('2026-07-25T00:00:25.000Z');
    expect(out.duration).toBe(8); // 3s + 5s
    expect(out.total_tokens).toBe(35); // 15 + 20
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0].operate_key).toBe('GENERATE_SQL');
    expect(out.steps[1].operate_key).toBe('GENERATE_CHART');
    // local_operation + error pass through verbatim (NOT null placeholders)
    expect(out.steps[0].local_operation).toBe(false);
    expect(out.steps[0].error).toBe(false);
    expect(out.steps[1].local_operation).toBe(false);
    expect(out.steps[1].error).toBe(false);
  });

  it('returns empty steps + record timestamps when no logs exist', () => {
    const out = toChatLogHistorySnake(makeRecord(), []);
    expect(out.steps).toEqual([]);
    expect(out.duration).toBeNull();
    expect(out.total_tokens).toBeNull();
  });

  it('withoutSteps keeps the aggregates but emits steps:[]', () => {
    // The /usage route serves only the totals; the per-step breakdown lives
    // behind /log.
    const logs = [
      makeLog({
        startedAt: new Date('2026-07-25T00:00:10.000Z'),
        endedAt: new Date('2026-07-25T00:00:13.000Z'),
        tokenUsage: { totalTokens: 15 },
        operate: 'GENERATE_SQL',
      }),
      makeLog({
        id: 101,
        startedAt: new Date('2026-07-25T00:00:20.000Z'),
        endedAt: new Date('2026-07-25T00:00:25.000Z'),
        tokenUsage: { totalTokens: 20 },
        operate: 'GENERATE_CHART',
      }),
    ];
    const out = toChatLogHistorySnake(makeRecord(), logs, {
      withoutSteps: true,
    });
    // Aggregates still computed from the logs...
    expect(out.start_time).toBe('2026-07-25T00:00:10.000Z');
    expect(out.finish_time).toBe('2026-07-25T00:00:25.000Z');
    expect(out.duration).toBe(8);
    expect(out.total_tokens).toBe(35);
    // ...but the per-step payload is dropped (the usage viewer doesn't render it).
    expect(out.steps).toEqual([]);
  });
});

describe('toChatLogHistoryItemSnake', () => {
  it('maps a single log to a step with duration in seconds', () => {
    const out = toChatLogHistoryItemSnake(
      makeLog({
        startedAt: new Date('2026-07-25T00:00:10.000Z'),
        endedAt: new Date('2026-07-25T00:00:13.500Z'), // 3.5s
        tokenUsage: { totalTokens: 15 },
        operate: 'ANALYSIS',
      }),
    );
    expect(out).toMatchObject({
      start_time: '2026-07-25T00:00:10.000Z',
      finish_time: '2026-07-25T00:00:13.500Z',
      duration: 4, // rounded to seconds (Math.round)
      total_tokens: 15,
      operate: 'ANALYSIS',
      operate_key: 'ANALYSIS',
      local_operation: false,
      error: false,
    });
  });

  it('nulls duration/finish_time when the log has no endedAt', () => {
    const out = toChatLogHistoryItemSnake(makeLog({ endedAt: null }));
    expect(out.finish_time).toBeNull();
    expect(out.duration).toBeNull();
  });

  // A SQL-gen failure log carries error=true + local_operation=false —
  // the mapper must surface both so the frontend renders the error icon.
  it('surfaces error=true + local_operation=true flags verbatim (§81)', () => {
    const failed = makeLog({
      operate: 'GENERATE_SQL',
      error: true,
      localOperation: false,
    });
    const local = makeLog({
      id: 102,
      operate: 'CHOOSE_TABLE',
      localOperation: true,
      error: false,
    });
    expect(toChatLogHistoryItemSnake(failed).error).toBe(true);
    expect(toChatLogHistoryItemSnake(failed).local_operation).toBe(false);
    expect(toChatLogHistoryItemSnake(local).error).toBe(false);
    expect(toChatLogHistoryItemSnake(local).local_operation).toBe(true);
  });
});
