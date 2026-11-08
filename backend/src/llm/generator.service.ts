// GeneratorService — the seven NL2SQL-pipeline generators
// (generate_sql / generate_chart / generate_analysis / generate_predict /
// generate_guess_question / select_datasource / generate_filter; a dynamic
// generator is intentionally not included). Each is an async
// generator: it renders a prompt from an AiModelQuestion, streams the resolved
// LLM, forwards reasoning + content deltas, then emits a final `result` event
// (parsed JSON for the structured generators, accumulated text for analysis).
import { Injectable } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { LlmService } from './llm.service';
import type { TokenUsage } from './llm.service';
import { PromptService } from './prompt.service';
import { extractNestedJson } from './extract-json';
import type {
  AiModelQuestion,
  ChartGenResult,
  FilterGenResult,
  GuessResult,
  PredictResult,
  SelectDsResult,
  SqlGenResult,
} from './ai-question';

/** A serialized message snapshot `{type, queryprism_system, content}`
 *  for the ChatLog.messages column. `queryprism_system` is the
 *  system flag for spliced prompts; this project never sets it → false. */
export interface SerializedMessage {
  type: string;
  queryprism_system: boolean;
  content: string;
}

/** The event stream every generator yields. `messages` is emitted
 *  first (the pre-stream prompt list, for startLog INSERT); `usage` carries the
 *  final-chunk token-usage snapshot (for endLog UPDATE). */
export type LlmGenEvent =
  | { type: 'messages'; messages: SerializedMessage[] }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'result'; data: unknown };

@Injectable()
export class GeneratorService {
  constructor(
    private readonly llm: LlmService,
    private readonly prompt: PromptService,
  ) {}

  async *generateSql(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run('generate_sql', ctx, parseSqlResult, modelId);
  }

  async *generateChart(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run('generate_chart', ctx, parseChartResult, modelId);
  }

  async *generateAnalysis(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    // Free-text: no JSON parse; the result is the accumulated content.
    yield* this.run(
      'generate_analysis',
      ctx,
      (text) => ({ analysis: text }),
      modelId,
    );
  }

  async *generatePredict(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run('generate_predict', ctx, parsePredictResult, modelId);
  }

  async *generateGuessQuestion(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run('generate_guess_question', ctx, parseGuessResult, modelId);
  }

  async *selectDatasource(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run('select_datasource', ctx, parseSelectDsResult, modelId);
  }

  /** The row-permission filter re-generator. Takes the original SQL +
   *  the per-table WHERE fragments (ctx.filter) and asks the LLM to merge
   *  them into a new SQL. Uses its own `permissions_system` system prompt
   *  (NOT the shared base `system`) — the filter template is a dedicated
   *  system+user pair. ctx.history is NOT injected (only System + Human
   *  are sent, no conversation history). */
  async *generateFilter(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run(
      'permissions',
      ctx,
      parseFilterResult,
      modelId,
      'permissions_system',
    );
  }

  /** Keyword extraction — free TEXT, not
   *  JSON (never routed through extractNestedJson). The result is the raw
   *  trimmed answer; the caller interprets the ERROR:NOT_DATA_QUERY / EMPTY
   *  sentinels. ctx.history must be USER-ONLY (prior
   *  questions are extracted, not AI replies). */
  async *extractKeywords(
    ctx: AiModelQuestion,
    modelId?: number,
  ): AsyncGenerator<LlmGenEvent> {
    yield* this.run(
      'extract_keywords',
      ctx,
      (text) => ({ keywords: text.trim() }),
      modelId,
    );
  }

  // ------------------------------------------------------------------ shared

  /** Render the template, stream the LLM, forward deltas, then emit a final
   *  result parsed by `parse` (or `{ analysis: text }` when parse is null).
   *  `systemKey` overrides the shared base `system` block for generators
   *  that have their own system prompt (generateFilter → `permissions_system`). */
  private async *run(
    templateKey: string,
    ctx: AiModelQuestion,
    parse: (text: string) => unknown,
    modelId?: number,
    systemKey: string = 'system',
  ): AsyncGenerator<LlmGenEvent> {
    const messages = this.buildMessages(templateKey, ctx, systemKey);
    // Emit the pre-stream message list first so the caller can
    // startLog INSERT it before the stream begins.
    yield { type: 'messages', messages: this.serializeMessages(messages) };
    let content = '';
    for await (const chunk of this.llm.stream(messages, modelId)) {
      if (chunk.reasoning) yield { type: 'reasoning', delta: chunk.reasoning };
      if (chunk.content) {
        content += chunk.content;
        yield { type: 'content', delta: chunk.content };
      }
      // Forward the final-chunk usage snapshot for endLog UPDATE.
      if (chunk.usage) yield { type: 'usage', usage: chunk.usage };
    }
    yield { type: 'result', data: parse(content) };
  }

  /** Serialize the LangChain BaseMessage[] to the
   *  `{type, queryprism_system, content}` shape for the ChatLog.messages column.
   *  `queryprism_system` is the system flag, never set → false.
   *  Content is coerced to a string (multimodal blocks JSON-stringified). */
  private serializeMessages(msgs: BaseMessage[]): SerializedMessage[] {
    return msgs.map((m) => ({
      type: m._getType(),
      queryprism_system: false,
      content:
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  }

  /** Build the LangChain message list: system role + injected history + the
   *  rendered task prompt as the current user turn. History is injected as
   *  messages, not duplicated in the template
   *  text. `systemKey` selects which system template to render (default
   *  `system`; generateFilter passes `permissions_system`). */
  private buildMessages(
    templateKey: string,
    ctx: AiModelQuestion,
    systemKey: string = 'system',
  ): BaseMessage[] {
    const ctxMap = this.toContextMap(ctx);
    const messages: BaseMessage[] = [
      new SystemMessage(this.prompt.render(systemKey, ctxMap)),
    ];
    if (ctx.history) {
      for (const h of ctx.history) {
        messages.push(
          h.role === 'assistant'
            ? new AIMessage(h.content)
            : new HumanMessage(h.content),
        );
      }
    }
    messages.push(new HumanMessage(this.prompt.render(templateKey, ctxMap)));
    return messages;
  }

  /** Flatten the AiModelQuestion into the {token: string} map the templates
   *  consume. Compound fields (datasourceList) are stringified so their
   *  (otherwise empty) placeholders don't leave bare braces. History is not
   *  mapped: it is injected as messages by buildMessages. */
  private toContextMap(
    ctx: AiModelQuestion,
  ): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {
      lang: ctx.lang,
      queryprism_name: ctx.queryprismName,
      engine: ctx.engine,
      question: ctx.question,
      schema: ctx.schema,
      sql: ctx.sql,
      sql_result: ctx.sqlResult,
      terminologies: ctx.terminologies,
      data_training: ctx.dataTraining,
      sample_data: ctx.sampleData,
      datasource_list: ctx.datasourceList
        ? ctx.datasourceList
            .map(
              (d) =>
                `${d.id}. ${d.name}${d.description ? ` - ${d.description}` : ''}`,
            )
            .join('\n')
        : '',
      // The guess template uses {articles_number} to bound the count.
      // Default 4 when unset (e.g. fire-and-forget
      // cache-warmer which doesn't pass a count).
      articles_number: String(ctx.articlesNumber ?? 4),
      // The per-table WHERE fragments (JSON-stringified) for generateFilter.
      filter: ctx.filter ?? '',
      // The runtime-matched custom-prompt body (empty when no
      // customPromptType was passed → renders as a blank line in the system
      // template, harmless).
      custom_prompt: ctx.customPrompt ?? '',
    };
    return map;
  }
}

// ----------------------------------------------------------------- parsers

/** Coerce an LLM JSON value to a string for result fields. Strings pass
 *  through; numbers/booleans stringify; objects/arrays/null/undefined → ''.
 *  Avoids `[object Object]` from naively calling String() on unknown. */
function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function parseSqlResult(text: string): SqlGenResult | null {
  const j = extractNestedJson(text);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  return {
    success: typeof o.success === 'boolean' ? o.success : true,
    sql: asString(o.sql),
    tables: Array.isArray(o.tables) ? o.tables.map((t) => String(t)) : [],
    chartType: asString(o['chart-type'] ?? o.chartType),
    brief: asString(o.brief),
  };
}

function parseChartResult(text: string): ChartGenResult | null {
  const j = extractNestedJson(text);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const chartType = asString(o.chartType ?? o['chart-type']);
  if (!chartType) return null;
  // Carry through every key except the chart-type ones (aliased above).
  const config: Record<string, unknown> = { ...o };
  delete config.chartType;
  delete config['chart-type'];
  return { chartType, config };
}

function parsePredictResult(text: string): PredictResult | null {
  const j = extractNestedJson(text);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  return {
    predict: asString(o.predict),
    predictData: o.predict_data ?? o.predictData ?? null,
  };
}

function parseGuessResult(text: string): GuessResult | null {
  const j = extractNestedJson(text);
  if (!Array.isArray(j) && (!j || typeof j !== 'object')) return null;
  let questions: unknown;
  if (Array.isArray(j)) {
    questions = j;
  } else {
    questions = (j as Record<string, unknown>).questions;
  }
  if (!Array.isArray(questions)) return null;
  return { questions: questions.map((q) => String(q)) };
}

function parseSelectDsResult(text: string): SelectDsResult | null {
  const j = extractNestedJson(text);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const id = o.datasource_id ?? o.datasourceId;
  if (id === undefined || id === null) return null;
  const num = Number(id);
  if (Number.isNaN(num)) return null;
  return { datasourceId: num };
}

/** Parse the generateFilter LLM response. The filter template
 *  returns `{"success":true,"sql":"..."}` or `{"success":false,"message":
 *  "..."}`. A null result (unparseable) is treated as failure-with-empty-sql
 *  so the caller falls back to the original SQL rather than executing nothing. */
function parseFilterResult(text: string): FilterGenResult | null {
  const j = extractNestedJson(text);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  return {
    success: typeof o.success === 'boolean' ? o.success : true,
    sql: asString(o.sql),
    message: asString(o.message) || undefined,
  };
}
