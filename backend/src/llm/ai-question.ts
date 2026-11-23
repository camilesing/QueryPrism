// Type definitions for the LLM prompt context and each generator's parsed
// result. Pure types + one mapping helper — no NestJS deps, so trivially
// importable anywhere.
import { normalizeDatasourceType } from '../datasource/datasource-type';

export type EngineType = 'MySQL' | 'PostgreSQL' | 'SQLite';

/** Map a Datasource.type string to the engine label used in prompts and
 *  few-shot example selection. Aliases (`pg`, `postgres`) are resolved by
 *  normalizeDatasourceType; imported Excel sheets live in the app's PostgreSQL
 *  store, so they speak the PostgreSQL dialect too. Unknown → null so callers
 *  can decide a fallback (e.g. default to MySQL). */
export function engineFromDatasourceType(type: string): EngineType | null {
  switch (normalizeDatasourceType(type)) {
    case 'mysql':
      return 'MySQL';
    case 'postgresql':
    case 'excel':
      return 'PostgreSQL';
    case 'sqlite':
      return 'SQLite';
    default:
      return null;
  }
}

/** A single round of chat history fed into the prompt. */
export interface ChatHistoryRound {
  role: 'user' | 'assistant';
  content: string;
}

/** A datasource option offered to the select_datasource generator. */
export interface DatasourceOption {
  id: number;
  name: string;
  description?: string;
}

/** The context object every generator renders a prompt from. Fields are
 *  optional because each generator only needs a subset (e.g. generate_sql
 *  needs schema + sampleData; generate_chart needs sql + sqlResult). Missing
 *  fields render as empty strings in the template. */
export interface AiModelQuestion {
  lang: string;
  queryprismName: string;
  engine: EngineType;
  question: string;
  schema?: string;
  sql?: string;
  sqlResult?: string;
  sampleData?: string;
  history?: ChatHistoryRound[];
  datasourceList?: DatasourceOption[];
  recommendedQuestion?: string;
  /** How many follow-up questions the guess generator should propose
   *  (flows into the template's {articles_number} placeholder; default 4). */
  articlesNumber?: number;
  /** The JSON-stringified per-table WHERE fragments fed to the
   *  generateFilter LLM generator.
   *  `[{"table":"users","filter":"(`age` > '18')"}]`. Only the generateFilter
   *  generator consumes this (sql + filter placeholders). */
  filter?: string;
  /** The concatenated custom-prompt body matched at runtime by
   *  CustomPromptService.findCustomPrompts. Flows into the system prompt via the
   *  `{custom_prompt}` placeholder. Only set when buildSqlContext is given
   *  a `customPromptType` (GENERATE_SQL/ANALYSIS/PREDICT_DATA) — chart /
   *  select_datasource / recommend paths omit it (no injection). */
  customPrompt?: string;
  /** MetaDataImprove M4: the `<metric_definitions>` block the chat pipeline
   *  resolved from the metric dictionary (derived/composite/atomic calibers
   *  whose name or alias EQUALS one of the question's extracted keywords).
   *  Flows into the generate_sql template's `{metrics}`
   *  placeholder; empty when nothing matched or metric.enabled is off. */
  metrics?: string;
  /** MetaDataImprove M4: the `<naming_rules>` block of naming-dictionary
   *  standard translations whose term/alias equals an extracted keyword or a
   *  name/comment of a stuffed table. Flows into the
   *  generate_sql template's `{naming_rules}` placeholder ('' when off). */
  namingRules?: string;
  /** MetaDataImprove clarify: recall candidates that were NOT stuffed into the
   *  narrowed schema, one `- table: meaning|comment` line each (the curated
   *  meaning only for a table an extracted keyword names, else its comment).
   *  Lets generate_sql name
   *  the exact additional tables it needs (`need_clarify.tables`) instead of
   *  guessing names outside the schema. Flows into `{candidate_tables}`. */
  candidateTables?: string;
}

// --- generator result types -----------------------------------------------

export interface SqlGenResult {
  success: boolean;
  sql: string;
  tables: string[];
  chartType: string;
  brief: string;
  /** MetaDataImprove M2 rule 2: the LLM declares the provided schema cannot
   *  answer (missing table/join) and asks the user to narrow — the pipeline
   *  turns this into the clarify flow instead of failing. */
  needClarify?: boolean;
  reason?: string;
}

export interface ChartGenResult {
  /** bar | column | line | pie | table | ... */
  chartType: string;
  config: Record<string, unknown>;
}

export interface AnalysisResult {
  analysis: string;
}

export interface PredictResult {
  predict: string;
  predictData: unknown;
}

export interface GuessResult {
  questions: string[];
}

export interface SelectDsResult {
  datasourceId: number;
}

/** The generateFilter generator's parsed result. The filter
 *  template returns `{"success":true,"sql":"<new or original SQL>"}` or
 *  `{"success":false,"message":"<reason>"}`. `message` is present only on
 *  failure (a syntax/security risk in the filter conditions). */
export interface FilterGenResult {
  success: boolean;
  sql: string;
  message?: string;
}
