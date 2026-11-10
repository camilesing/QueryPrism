// ChatSseEvent — the discriminated union of every Server-Sent Event the
// chat pipeline emits. The ChatService.runPipeline / regenerate / runAnalysis /
// runPredict async generators yield these; the ChatController SSE handler
// pumps them through SseWriter (which frames each as `data:<json>\n\n` with
// `type` merged into the JSON top-level).
//
// Event names + payload shapes follow the frontend contract. Naming
// inconsistencies are INTENTIONAL (hyphen vs
// underscore preserved verbatim — the frontend matches by literal):
//   - underscore terminals: `analysis_finish` / `predict_finish`
//   - hyphen: `predict-success` / `predict-failed` / `*-result`
//   - `sql-data` (hyphen) carries only `{content:'execute-success'}` — the
//     frontend then GETs /chat/record/:rid/data for the rows (no inline data).
//   - `chart` carries `{content: JSON.stringify(config)}` (JSON string; the
//     frontend JSONBig.parse-es it). `sql` carries `{content: <sql string>}`.
//   - `*-result` events stream live LLM deltas: `content` = the visible
//     token stream, `reasoning_content` = the thinking stream. Each frame
//     carries one or the other (optional fields) — callers split the LLM
//     `content`/`reasoning` LlmGenEvents into the matching field.
//   - `finish` / `analysis_finish` / `predict-success` / `predict-failed` /
//     `predict_finish` carry an empty payload `{}`.
export interface ChatSseEventMap {
  id: { id: number };
  regenerate_record_id: { regenerate_record_id: number };
  question: { question: string };
  datasource: {
    id: number;
    datasource_name: string;
    engine_type: string;
  };
  'datasource-result': {
    content?: string;
    reasoning_content?: string;
  };
  'sql-result': { content?: string; reasoning_content?: string };
  sql: { content: string };
  'sql-data': { content: string };
  'chart-result': { content?: string; reasoning_content?: string };
  chart: { content: string };
  'analysis-result': { content?: string; reasoning_content?: string };
  analysis_finish: Record<string, never>;
  'predict-result': { content?: string; reasoning_content?: string };
  'predict-success': Record<string, never>;
  'predict-failed': Record<string, never>;
  predict_finish: Record<string, never>;
  // Recommend-questions stream. `recommended_question_result` carries
  // the live LLM reasoning deltas; `recommended_question` is the terminal
  // frame whose `content` is a JSON.stringify'd string[] (the frontend
  // JSONBig.parse-es it). The MVP emitted only the terminal frame from the
  // cached chat.recommendedQuestion; the live LLM stream landed in Phase 10.
  recommended_question_result: { content?: string; reasoning_content?: string };
  recommended_question: { content: string };
  // Clarify round (MetaDataImprove M1 rule 1): emitted when the recall step
  // found >= threshold candidate tables and the question names none of them.
  // The stream then terminates with `finish` (the record stays finish:false
  // + clarifyStatus:'pending' in the DB); the user answers via
  // POST /chat/record/:rid/clarify which re-streams the same record. While
  // the record's clarify-round budget remains (clarify.max_rounds > 1) a
  // resumed run may pause again with a new frame for the same record.
  // `reason` is present when the pause came from the LLM's need_clarify
  // contract (M2 rule 2) — its one-liner about what the schema is missing.
  // `meaning` is the effective table semantic (falls back to `comment` in the
  // UI); `suggested_table_ids` is the current schema plus the tables the LLM
  // named, already filtered to candidates and capped at max_select.
  clarify: {
    record_id: number;
    question: string;
    candidates: Array<{
      table_id: number;
      table_name: string;
      comment: string;
      meaning?: string;
    }>;
    max_select: number;
    reason?: string;
    suggested_table_ids?: number[];
  };
  info: { msg: string };
  brief: { brief: string };
  error: { content: string };
  finish: Record<string, never>;
}

export type ChatSseEventType = keyof ChatSseEventMap;

export type ChatSseEvent = {
  [K in ChatSseEventType]: { type: K; data: ChatSseEventMap[K] };
}[ChatSseEventType];
