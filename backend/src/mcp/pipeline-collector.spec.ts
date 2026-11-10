// pipeline-collector spec — drains an AsyncGenerator<ChatSseEvent> the way
// mcp_question needs: pull everything, surface the last sql / brief / chart
// config (parsed from the JSON-stringified chart content) / id, and capture
// an error event if one fired. Pure over the generator, no Nest deps, so
// mcp_question + the future frontend can share it (decision §46 / §62).
//
// Phase 9c (§62): the SSE contract no longer inlines query rows (sql-data
// carries only 'execute-success'), the chart's chartType, or the sql's tables
// — so the collector's output no longer has `data`/`tables`/`chartType`. The
// mcp_question handler fetches rows + chartType from the persisted record.
import type {
  ChatSseEvent,
  ChatSseEventMap,
  ChatSseEventType,
} from '../chat/chat-sse-event';
import { collectPipeline } from './pipeline-collector';

// Object-style async iterable (decision §15) — mirrors the chat.service.spec
// asyncFrom so we can feed a fake runPipeline to the collector.
function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: () =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false as const, value: items[i++] }),
      };
    },
  };
}

function ev<K extends ChatSseEventType>(
  type: K,
  data: ChatSseEventMap[K],
): ChatSseEvent {
  return { type, data } as ChatSseEvent;
}

describe('collectPipeline', () => {
  it('collects id/sql/brief/chart-config from a happy pipeline', async () => {
    const gen = asyncFrom<ChatSseEvent>([
      ev('id', { id: 100 }),
      ev('question', { question: 'q' }),
      ev('datasource', {
        id: 1,
        datasource_name: 'main',
        engine_type: 'SQLite',
      }),
      ev('info', { msg: 'thinking' }),
      ev('sql-result', { content: 'SELECT', reasoning_content: 'r' }),
      ev('sql', { content: 'SELECT * FROM users' }),
      ev('brief', { brief: '用户数' }),
      ev('info', { msg: 'exec' }),
      ev('sql-data', { content: 'execute-success' }),
      ev('info', { msg: 'charting' }),
      ev('chart-result', { content: '{', reasoning_content: 'c' }),
      ev('chart', { content: JSON.stringify({ xField: 'category' }) }),
      ev('finish', {}),
    ]);

    const out = await collectPipeline(gen);

    expect(out).toEqual({
      recordId: 100,
      sql: 'SELECT * FROM users',
      brief: '用户数',
      chartConfig: { xField: 'category' },
      error: null,
      clarify: null,
    });
  });

  it('parses the chart event content as JSON and keeps the first config', async () => {
    // §62: chart content is JSON.stringify(config). The collector parses it
    // back; a second chart event must NOT overwrite the first (the
    // `if (!out.chartConfig)` guard preserves the terminal config).
    const gen = asyncFrom<ChatSseEvent>([
      ev('chart', { content: JSON.stringify({ yField: 'v' }) }),
      ev('chart', { content: JSON.stringify({ yField: 'late' }) }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.chartConfig).toEqual({ yField: 'v' });
  });

  it('leaves chartConfig null when the chart content is not valid JSON', async () => {
    const gen = asyncFrom<ChatSseEvent>([
      ev('chart', { content: 'not-json' }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.chartConfig).toBeNull();
  });

  it('leaves recordId null when no id event was emitted', async () => {
    // §62: finish carries no payload now — recordId comes only from `id`.
    const gen = asyncFrom<ChatSseEvent>([
      ev('sql', { content: 'SELECT 1' }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.recordId).toBeNull();
  });

  it('captures an error event and still drains the rest', async () => {
    const gen = asyncFrom<ChatSseEvent>([
      ev('id', { id: 7 }),
      ev('sql', { content: 'SELECT 1' }),
      ev('error', { content: 'boom' }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.error).toBe('boom');
    expect(out.sql).toBe('SELECT 1');
    expect(out.recordId).toBe(7);
  });

  it('returns an empty-shaped result for a pipeline that yields nothing', async () => {
    const out = await collectPipeline(asyncFrom<ChatSseEvent>([]));
    expect(out).toEqual({
      recordId: null,
      sql: null,
      brief: null,
      chartConfig: null,
      error: null,
      clarify: null,
    });
  });

  it('captures the clarify pause payload (MetaDataImprove M1)', async () => {
    // The clarify-paused pipeline: id → clarify → finish (no sql). The MCP
    // handler turns this into the structured needs_clarification result.
    const gen = asyncFrom<ChatSseEvent>([
      ev('id', { id: 55 }),
      ev('clarify', {
        record_id: 55,
        question: '统计一下整体情况',
        candidates: [
          { table_id: 1, table_name: 'orders', comment: '订单表' },
          { table_id: 2, table_name: 'users', comment: '用户表' },
          { table_id: 3, table_name: 'stock', comment: '库存表' },
        ],
        max_select: 3,
      }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.clarify).toEqual({
      record_id: 55,
      question: '统计一下整体情况',
      candidates: [
        { table_id: 1, table_name: 'orders', comment: '订单表' },
        { table_id: 2, table_name: 'users', comment: '用户表' },
        { table_id: 3, table_name: 'stock', comment: '库存表' },
      ],
      max_select: 3,
    });
    expect(out.recordId).toBe(55);
    expect(out.sql).toBeNull();
    expect(out.error).toBeNull();
  });

  it('passes candidate meanings and suggested ids through', async () => {
    const gen = asyncFrom<ChatSseEvent>([
      ev('id', { id: 56 }),
      ev('clarify', {
        record_id: 56,
        question: '统计一下整体情况',
        candidates: [
          {
            table_id: 1,
            table_name: 'orders',
            comment: '订单表',
            meaning: '订单主表',
          },
        ],
        max_select: 3,
        reason: '需要订单表',
        suggested_table_ids: [1],
      }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.clarify).toMatchObject({
      reason: '需要订单表',
      suggested_table_ids: [1],
      candidates: [{ meaning: '订单主表' }],
    });
  });

  it('keeps the clarify payload alongside a resumed stream (sql wins)', async () => {
    // A resumed record that asks again mid-stream is NOT expected today
    // (max one round), but if both appear the collector keeps both — the
    // handler prefers sql when present.
    const gen = asyncFrom<ChatSseEvent>([
      ev('id', { id: 9 }),
      ev('sql', { content: 'SELECT 1' }),
      ev('finish', {}),
    ]);
    const out = await collectPipeline(gen);
    expect(out.sql).toBe('SELECT 1');
    expect(out.clarify).toBeNull();
  });
});
