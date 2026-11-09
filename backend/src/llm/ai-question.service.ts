// AiQuestionService — assembles the AiModelQuestion context object each
// generator renders a prompt from. Gathers the M-Schema, per-table sample
// data, RAG-recalled terminologies and data-training samples from the
// Phase 2/3 services. This front-loads the gathering the Phase 5 chat
// pipeline will orchestrate. Terminology / data-training recall read the
// workspace oid from RequestContext, so this must run inside a request
// scope (or a requestContextStorage.run(...) in tests / background tasks).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatasourceService } from '../datasource/datasource.service';
import { TerminologyService } from '../terminology/terminology.service';
import { DataTrainingService } from '../data-training/data-training.service';
import { CustomPromptService } from '../custom-prompt/custom-prompt.service';
import { RequestContext } from '../common/context/request-context';
import { PrismaService } from '../database/prisma.service';
import { jsonValueToString } from '../common/utils/json-value';
import type { EmbeddingConfig } from '../common/config/embedding-config';
import type {
  AiModelQuestion,
  ChatHistoryRound,
  DatasourceOption,
  EngineType,
} from './ai-question';
import type { MSchemaSemantics } from '../datasource/m-schema.builder';

/** Caps on the sample-data gather so the prompt stays bounded. */
const MAX_SAMPLE_TABLES = 8;
const SAMPLE_ROWS = 3;

@Injectable()
export class AiQuestionService {
  private readonly logger = new Logger(AiQuestionService.name);

  constructor(
    private readonly datasourceService: DatasourceService,
    private readonly terminologyService: TerminologyService,
    private readonly dataTrainingService: DataTrainingService,
    private readonly customPromptService: CustomPromptService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Build the SQL-generation context: schema + sample data + recalled
   *  terminology + recalled samples + recent history. `tableIds` (from the
   *  embedding pre-filter) narrows the M-Schema to the recalled subset.
   *  `embeddingConfig` is the task-start retrieval snapshot (9e6070e8) —
   *  terminology / data-training recall follow its switches + thresholds. */
  async buildSqlContext(opts: {
    question: string;
    datasourceId: number;
    engine: EngineType;
    history?: ChatHistoryRound[];
    tableIds?: number[];
    /** Per-turn language override (the question's detected language); falls
     *  back to the user's profile language when omitted. */
    lang?: string;
    /** §110: when set (GENERATE_SQL/ANALYSIS/PREDICT_DATA), the runtime-
     *  matched custom-prompt body is looked up via CustomPromptService and
     *  injected into the system prompt. Omitted for chart / select_datasource
     *  / recommend paths (no injection). */
    customPromptType?: string;
    /** Query used for terminology/data-training recall — defaults to the
     *  question; the analysis re-run passes the record's saved keywords. */
    knowledgeQuery?: string;
    embeddingConfig?: EmbeddingConfig;
    /** MetaDataImprove M2: effective table/field semantics — injected into the
     *  M-Schema as the authoritative comment layer (getMSchema passthrough). */
    semantics?: MSchemaSemantics;
    /** MetaDataImprove M4: pre-rendered metric-definition and naming-rule
     *  blocks (the chat pipeline resolves them next to `semantics`; empty
     *  string / undefined renders a blank section, same as terminologies). */
    metrics?: string;
    namingRules?: string;
  }): Promise<AiModelQuestion> {
    const sampleDataEnabled = await this.sampleDataEnabled();
    const [schema, sampleData, terminologies, dataTraining, customPromptText] =
      await Promise.all([
        this.datasourceService.getMSchema(
          opts.datasourceId,
          opts.tableIds,
          opts.semantics,
        ),
        sampleDataEnabled
          ? this.gatherSampleData(opts.datasourceId)
          : Promise.resolve(''),
        this.terminologyService.getTerminologyTemplate(
          opts.knowledgeQuery ?? opts.question,
          opts.datasourceId,
          undefined,
          opts.embeddingConfig,
        ),
        this.dataTrainingService.getDataTrainingTemplate(
          opts.knowledgeQuery ?? opts.question,
          opts.datasourceId,
          undefined,
          opts.embeddingConfig,
        ),
        opts.customPromptType
          ? this.customPromptService
              .findCustomPrompts(
                opts.customPromptType,
                RequestContext.getUser()?.oid ?? 0,
                opts.datasourceId,
              )
              .then((r) => r.customPromptText)
          : Promise.resolve(''),
      ]);
    return {
      lang: opts.lang ?? this.lang(),
      queryprismName: this.queryprismName(),
      engine: opts.engine,
      question: opts.question,
      schema,
      sampleData,
      terminologies,
      dataTraining,
      history: opts.history,
      customPrompt: customPromptText,
      metrics: opts.metrics,
      namingRules: opts.namingRules,
    };
  }

  /** Build a result-phase context (chart / analysis / predict): reuse the SQL
   *  context and attach the executed SQL + its result. `tableIds` flows to
   *  buildSqlContext so the chart prompt sees the same narrowed schema. */
  async buildForResult(opts: {
    question: string;
    datasourceId: number;
    engine: EngineType;
    sql: string;
    sqlResult: string;
    history?: ChatHistoryRound[];
    tableIds?: number[];
    /** §110: passed through to buildSqlContext (ANALYSIS/PREDICT_DATA for
     *  the secondary contexts; omitted for GENERATE_CHART). */
    customPromptType?: string;
    /** Passed through to buildSqlContext (analysis re-runs on saved keywords). */
    knowledgeQuery?: string;
    embeddingConfig?: EmbeddingConfig;
    /** Per-turn language override — passed through to buildSqlContext. */
    lang?: string;
    /** MetaDataImprove M2: passed through to buildSqlContext. */
    semantics?: MSchemaSemantics;
    /** MetaDataImprove M4: passed through to buildSqlContext. */
    metrics?: string;
    namingRules?: string;
  }): Promise<AiModelQuestion> {
    const base = await this.buildSqlContext(opts);
    base.sql = opts.sql;
    base.sqlResult = opts.sqlResult;
    return base;
  }

  /** 3fd6fa86: the extract_keywords context — question + lang/queryprismName +
   *  the caller-supplied USER-ONLY history (upstream feeds prior user
   *  questions as context, never AI replies). */
  buildForKeywords(opts: {
    question: string;
    engine: EngineType;
    history?: ChatHistoryRound[];
    lang?: string;
  }): AiModelQuestion {
    return {
      lang: opts.lang ?? this.lang(),
      queryprismName: this.queryprismName(),
      engine: opts.engine,
      question: opts.question,
      history: opts.history,
    };
  }

  /** Build the select-datasource context. `engine` is unused by the
   *  select_datasource template; a placeholder satisfies the required field. */
  buildForSelectDatasource(opts: {
    question: string;
    datasources: DatasourceOption[];
    lang?: string;
  }): AiModelQuestion {
    return {
      lang: opts.lang ?? this.lang(),
      queryprismName: this.queryprismName(),
      engine: 'MySQL',
      question: opts.question,
      datasourceList: opts.datasources,
    };
  }

  /** §111: build the generateFilter context — the original SQL + the per-table
   *  WHERE fragments (already JSON-stringified by the caller). Only
   *  lang/queryprismName/engine/sql/filter are consumed by the `permissions`
   *  template; no M-Schema / RAG gathering (the filter re-gen is a surgical
   *  merge, not a from-scratch NL2SQL). */
  buildFilterContext(opts: {
    engine: EngineType;
    sql: string;
    filter: string;
    lang?: string;
  }): AiModelQuestion {
    return {
      lang: opts.lang ?? this.lang(),
      queryprismName: this.queryprismName(),
      engine: opts.engine,
      // No user question for the filter re-gen — the permissions template only
      // consumes {sql}/{filter}; question stays empty so AiModelQuestion satisfies.
      question: '',
      sql: opts.sql,
      filter: opts.filter,
    };
  }

  /** 0b5588b5: whether to fetch table sample data into the SQL prompt.
   *  Priority: saved SystemParameter chat.sample_data_enabled > env default
   *  (CHAT_SAMPLE_DATA_ENABLED, default true). Same direct-SystemVariable
   *  read as auth.service loginFlagEnabled (a missing row = not saved). */
  private async sampleDataEnabled(): Promise<boolean> {
    const row = await this.prisma.systemVariable.findFirst({
      where: { type: 'parameter', name: 'chat.sample_data_enabled' },
    });
    if (!row) {
      return this.config.get<boolean>('chat.sampleDataEnabled') ?? true;
    }
    return jsonValueToString(row.value).trim().toLowerCase() === 'true';
  }

  /** Gather up to MAX_SAMPLE_TABLES checked tables, SAMPLE_ROWS each,
   *  formatted compactly. Tables that can't be sampled (dropped since the
   *  last sync) are skipped. */
  private async gatherSampleData(datasourceId: number): Promise<string> {
    const ds = await this.datasourceService.findOne(datasourceId);
    const tables = ds.tables
      .filter((t) => t.checked)
      .slice(0, MAX_SAMPLE_TABLES);
    const blocks: string[] = [];
    for (const t of tables) {
      try {
        const { columns, rows } = await this.datasourceService.previewTable(
          datasourceId,
          t.tableName,
          SAMPLE_ROWS,
        );
        blocks.push(
          `Table: ${t.tableName}\nColumns: ${columns.join(', ')}\n${JSON.stringify(rows)}`,
        );
      } catch (e) {
        this.logger.warn(
          `sample data skipped for ${t.tableName}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return blocks.join('\n\n');
  }

  private lang(): string {
    return RequestContext.getUser()?.language ?? 'en';
  }

  private queryprismName(): string {
    return this.config.get<string>('chat.queryprismName') ?? 'QueryPrism';
  }
}
