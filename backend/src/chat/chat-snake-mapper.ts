// chat-snake-mapper — the frontend
// reads ChatInfo / ChatRecord / ChatLogHistory in snake_case. We use
// explicit per-service mappers here instead of a global camelToSnake
// interceptor, so nested Json blobs (chart config, sqlExecResult, predictData,
// recommendedQuestion) pass through verbatim — a global interceptor would
// mangle their inner field names (xField→x_field, etc.) and break the chart
// renderer. Only top-level scalar fields are renamed.
//
// Field-name decisions: `datasource` on a record mirrors the chat's
// datasourceId (stored denormalized per record); `chart_type` is
// NOT emitted per record (it lives on the chat-level config; the
// frontend reads it from the `chart` blob's type); `create_by` is the Chat's
// creator uid (null for legacy rows); `finish_time` reuses updatedAt (the
// pipeline sets it on terminal write). Json blobs (data/predict_data/
// recommended_question) are passed by reference; `chart` is re-serialized to
// a JSON string because the frontend calls JSON.parse() on it (the
// SSE `chart` event carries the same string).
import type {
  Chat,
  ChatLog,
  ChatRecord,
  Datasource,
  Prisma,
} from '@prisma/client';
import { buildQueryPrismChartObject } from '../chart/chart-object.builder';

export interface ChatRecordSnake {
  id: number;
  chat_id: number;
  create_time: string;
  finish_time: string;
  question: string;
  sql_answer: string | null;
  sql: string | null;
  datasource: number | null;
  data: unknown;
  chart_answer: string | null;
  /** JSON.stringify'd chart object — the frontend JSON.parse()s it. */
  chart: string | null;
  analysis: string | null;
  analysis_thinking: string | null;
  predict: string | null;
  predict_content: string | null;
  predict_data: unknown;
  finish: boolean;
  error: string | null;
  run_time: number;
  first_chat: boolean;
  recommended_question: unknown;
  analysis_record_id: number | null;
  predict_record_id: number | null;
  regenerate_record_id: number | null;
  duration: number | null;
  total_tokens: number | null;
}

export interface ChatInfoSnake {
  id: number;
  create_time: string;
  latest_record_time: string;
  create_by: number | null;
  brief: string | null;
  chat_type: string | null;
  datasource: number | null;
  engine_type: string | null;
  ds_type: string | null;
  datasource_name: string | null;
  datasource_exists: boolean;
  records: ChatRecordSnake[];
  recommended_question: unknown;
  recommended_generate: boolean | null;
}

export interface ChatLogHistoryItemSnake {
  start_time: string;
  finish_time: string | null;
  duration: number | null;
  total_tokens: number | null;
  operate: string | null;
  operate_key: string | null;
  local_operation: boolean | null;
  error: boolean | null;
  message: unknown;
}

export interface ChatLogHistorySnake {
  start_time: string;
  finish_time: string | null;
  duration: number | null;
  total_tokens: number | null;
  steps: ChatLogHistoryItemSnake[];
}

const ISO = (d: Date): string => d.toISOString();

/** Column names from a persisted `sqlExecResult` Json blob, or [] when the
 *  column is null/unknown-shaped. */
function sqlResultColumns(stored: Prisma.JsonValue | null): string[] {
  if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) {
    return [];
  }
  const columns = (stored as { columns?: unknown }).columns;
  return Array.isArray(columns)
    ? columns.filter((c): c is string => typeof c === 'string')
    : [];
}

/** `record.chart` is a Prisma Json column (object at runtime) but the
 *  frontend expects the TEXT-column contract and JSON.parse()s it. Rows
 *  written before the chart-object contract stored only the LLM field mapping
 *  ({xField,yField,seriesField}); rebuild that into the chart object on read
 *  (using the record's chartType + result columns) so old conversations keep
 *  rendering instead of showing an empty chart card. */
function serializeChart(record: ChatRecord): string | null {
  const stored = record.chart;
  if (stored == null) return null;

  let parsed: unknown = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return stored;
    }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof stored === 'string' ? stored : JSON.stringify(stored);
  }

  const chart = parsed as Record<string, unknown>;
  if (typeof chart.type === 'string') return JSON.stringify(chart);

  return JSON.stringify(
    buildQueryPrismChartObject(
      record.chartType ?? 'table',
      chart,
      sqlResultColumns(record.sqlExecResult),
    ),
  );
}

/** Per-record snake_case mapping. `withData` populates `data` with the
 *  persisted sqlExecResult (the with_data route renders the chart inline);
 *  without it, `data` is null and the frontend GETs rows separately. */
export function toChatRecordSnake(
  record: ChatRecord,
  opts?: { chat?: Chat | null; withData?: boolean },
): ChatRecordSnake {
  const chat = opts?.chat ?? null;
  return {
    id: record.id,
    chat_id: record.chatId,
    create_time: ISO(record.createdAt),
    finish_time: ISO(record.updatedAt),
    question: record.question,
    sql_answer: record.sqlAnswer,
    sql: record.sql,
    datasource: chat?.datasourceId ?? null,
    data: opts?.withData ? (record.sqlExecResult ?? null) : null,
    chart_answer: record.chartAnswer,
    chart: serializeChart(record),
    analysis: record.analysis,
    analysis_thinking: record.analysisThinking,
    predict: record.predict,
    predict_content: record.predictContent,
    predict_data: record.predictData,
    finish: record.finish,
    error: record.error,
    run_time: record.runTime,
    first_chat: record.firstChat,
    recommended_question: record.recommendedQuestion,
    analysis_record_id: record.analysisRecordId,
    predict_record_id: record.predictRecordId,
    regenerate_record_id: record.regenerateRecordId,
    duration: record.duration,
    total_tokens: record.totalTokens,
  };
}

/** Per-chat snake_case mapping. `datasource` (joined) feeds datasource_name
 *  + datasource_exists; `records` are pre-mapped ChatRecordSnake[]. */
export function toChatInfoSnake(
  chat: Chat,
  opts?: {
    datasource?: Datasource | null;
    records?: ChatRecordSnake[];
  },
): ChatInfoSnake {
  // latest_record_time = max(record create_time), falling back to
  // the chat's own create_time (coalesce). ISO strings compare
  // lexicographically, so max() over the mapped create_time strings works.
  const recordTimes = (opts?.records ?? [])
    .map((r) => r.create_time)
    .filter(Boolean);
  return {
    id: chat.id,
    create_time: ISO(chat.createdAt),
    latest_record_time: recordTimes.length
      ? recordTimes.reduce((a, b) => (a > b ? a : b))
      : ISO(chat.createdAt),
    create_by: chat.createBy ?? null,
    brief: chat.brief,
    chat_type: chat.chatType,
    datasource: chat.datasourceId,
    engine_type: chat.engineType,
    // ChatInfo.ds_type is set from the joined datasource on every read;
    // the Chat column only exists as a fallback for datasource-less rows.
    ds_type: opts?.datasource?.type ?? chat.dsType,
    datasource_name: opts?.datasource?.name ?? null,
    datasource_exists: opts?.datasource != null,
    records: opts?.records ?? [],
    recommended_question: chat.recommendedQuestion,
    recommended_generate: chat.recommendedGenerate,
  };
}

/** Per-LLM-call step. `duration` is seconds (rounded); null when the call has
 *  no endedAt (still running / crashed). `total_tokens` reads
 *  tokenUsage.totalTokens defensively (the Json shape is loose). */
export function toChatLogHistoryItemSnake(
  log: ChatLog,
): ChatLogHistoryItemSnake {
  const endedAt = log.endedAt;
  const duration =
    endedAt != null
      ? Math.round((endedAt.getTime() - log.startedAt.getTime()) / 1000)
      : null;
  const tokenUsage = log.tokenUsage as { totalTokens?: number } | null;
  return {
    start_time: ISO(log.startedAt),
    finish_time: endedAt != null ? ISO(endedAt) : null,
    duration,
    total_tokens: tokenUsage?.totalTokens ?? null,
    operate: log.operate,
    operate_key: log.operate,
    local_operation: log.localOperation ?? false, // local-step flag (false for LLM calls)
    error: log.error ?? false, // true on SQL-gen/safety/exec failure
    message: log.messages,
  };
}

/** Aggregate log history for a record: start/finish span the logs, duration +
 *  total_tokens sum across steps. When the record has no logs, steps is []
 *  and the aggregates are null (the viewer shows an empty state).
 *
 *  `withoutSteps` (served by `/record/:rid/usage`): the aggregates
 *  (start_time/finish_time/duration/total_tokens) are still computed, but
 *  `steps` is `[]`. The usage viewer only shows the totals; the per-step
 *  breakdown lives behind `/record/:rid/log`. */
export function toChatLogHistorySnake(
  record: ChatRecord,
  logs: ChatLog[],
  opts?: { withoutSteps?: boolean },
): ChatLogHistorySnake {
  if (logs.length === 0) {
    return {
      start_time: ISO(record.createdAt),
      finish_time: ISO(record.updatedAt),
      duration: null,
      total_tokens: null,
      steps: [],
    };
  }
  const firstStart = logs[0].startedAt;
  const lastFinish = logs[logs.length - 1].endedAt;
  let duration = 0;
  let totalTokens = 0;
  let hasDuration = false;
  let hasTokens = false;
  for (const l of logs) {
    if (l.endedAt != null) {
      duration += Math.round(
        (l.endedAt.getTime() - l.startedAt.getTime()) / 1000,
      );
      hasDuration = true;
    }
    const tu = l.tokenUsage as { totalTokens?: number } | null;
    if (tu?.totalTokens != null) {
      totalTokens += tu.totalTokens;
      hasTokens = true;
    }
  }
  return {
    start_time: ISO(firstStart),
    finish_time: lastFinish != null ? ISO(lastFinish) : null,
    duration: hasDuration ? duration : null,
    total_tokens: hasTokens ? totalTokens : null,
    steps: opts?.withoutSteps ? [] : logs.map(toChatLogHistoryItemSnake),
  };
}
