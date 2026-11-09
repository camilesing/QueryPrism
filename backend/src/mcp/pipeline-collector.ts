// collectPipeline: drains an AsyncGenerator<ChatSseEvent> (the output of
// ChatService.runPipeline) into a flat snapshot mcp_question can serialize.
// Only the structured events matter here — reasoning/info deltas are consumed
// live by the SSE controller, not by the MCP non-streaming path (§48).
//
// Phase 9c (§62): the SSE contract no longer inlines query rows (sql-data
// carries only `{content:'execute-success'}`), the chart's chartType, or the
// sql's tables. So the collector only extracts what the stream still carries:
// recordId (from `id`), sql (from `sql` content), brief, chartConfig (parsed
// from `chart` content's JSON string), and error. The MCP handler fetches the
// rows + chartType from the persisted ChatRecord via ChatService afterwards.
import type { ChatSseEvent } from '../chat/chat-sse-event';

export interface CollectedPipeline {
  recordId: number | null;
  sql: string | null;
  brief: string | null;
  chartConfig: Record<string, unknown> | null;
  error: string | null;
  /** Clarify round (MetaDataImprove M1): set when the pipeline paused with a
   *  pending question instead of producing SQL. The MCP caller answers by
   *  re-calling ask_question with clarify_record_id + the picked tables /
   *  supplement / skip. */
  clarify: {
    record_id: number;
    question: string;
    candidates: Array<{
      table_id: number;
      table_name: string;
      comment: string;
    }>;
    max_select: number;
  } | null;
}

/** Best-effort JSON.parse — returns null on failure (defensive; the chart
 *  event content is always JSON.stringify'd by the service, but a corrupt
 *  frame must not crash the non-streaming MCP path). */
function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function collectPipeline(
  gen: AsyncIterable<ChatSseEvent>,
): Promise<CollectedPipeline> {
  const out: CollectedPipeline = {
    recordId: null,
    sql: null,
    brief: null,
    chartConfig: null,
    error: null,
    clarify: null,
  };
  for await (const ev of gen) {
    switch (ev.type) {
      case 'id':
        out.recordId = ev.data.id;
        break;
      case 'sql':
        out.sql = ev.data.content;
        break;
      case 'brief':
        out.brief = ev.data.brief;
        break;
      case 'chart':
        // chart content is JSON.stringify(config) — parse it back.
        if (!out.chartConfig) {
          out.chartConfig = safeJsonParse(ev.data.content);
        }
        break;
      case 'clarify':
        out.clarify = { ...ev.data };
        break;
      case 'error':
        out.error = ev.data.content;
        break;
      case 'finish':
        // finish carries no payload now (§62); recordId comes from `id`.
        break;
    }
  }
  return out;
}
