// ChatService — the Phase 5 SSE chat pipeline. Orchestrates the closed loop
// NL2SQL → execute → chart as an async generator yielding ChatSseEvent frames;
// the controller's SSE handler pumps them through SseWriter. Every chat and
// ChatRecord is oid-scoped via RequestContext (mirror Terminology). A failure
// mid-pipeline yields an `error` + terminal event and persists the error on
// the ChatRecord instead of throwing, so the client always gets a clean close.
//
// Event names + payloads are aligned to the frontend contract.
// `*-result` events stream live LLM deltas split into `content` (visible) +
// `reasoning_content` (thinking); `sql`/`chart` carry `{content}` (the SQL
// string / JSON.stringify(chart object)); `sql-data` carries `{content:
// 'execute-success'}` (rows fetched via follow-up GET); `finish`/`*_finish`/
// `predict-success`/`predict-failed` carry empty payloads.
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type Chat,
  type ChatRecord,
  type Datasource,
} from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { DatasourceService } from '../datasource/datasource.service';
import type { QueryResult } from '../datasource/db-connector/db-connector.interface';
import { AiQuestionService } from '../llm/ai-question.service';
import {
  GeneratorService,
  type SerializedMessage,
} from '../llm/generator.service';
import type { TokenUsage } from '../llm/llm.service';
import {
  engineFromDatasourceType,
  type AiModelQuestion,
  type AnalysisResult,
  type ChatHistoryRound,
  type ChartGenResult,
  type EngineType,
  type FilterGenResult,
  type GuessResult,
  type PredictResult,
  type SelectDsResult,
  type SqlGenResult,
} from '../llm/ai-question';
import { SqlSafetyService } from './sql-safety.service';
import { RowPermissionService } from '../permission/row-permission.service';
import type { ChatSseEvent } from './chat-sse-event';
import {
  toChatLogHistorySnake,
  type ChatLogHistorySnake,
} from './chat-snake-mapper';
import {
  toQueryPrismDataShape,
  toQueryPrismListShape,
  type QueryPrismDataShape,
} from '../common/utils/queryprism-data-shape';
import { AuditService } from '../audit/audit.service';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import { detectQuestionLanguage } from '../common/utils/detect-language';
import { chatMessages } from './chat-messages';
import { TerminologyService } from '../terminology/terminology.service';
import {
  SemanticService,
  type SemanticAnnotations,
} from '../semantic/semantic.service';
import { MetricService } from '../semantic/metric.service';
import { DataStandardService } from '../semantic/standard.service';
import {
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from '../common/config/embedding-config';
import {
  matchSuggestedTableIds,
  needsClarify,
  type TableRecallCandidate,
} from '../datasource/table-recall';
import {
  normalizeTableRelation,
  relationIdNamesOf,
} from '../datasource/m-schema.builder';
import { joinBridgeTables } from '../datasource/join-path';
import { buildQueryPrismChartObject } from '../chart/chart-object.builder';

/** A just-created chat with the relations the start contract returns
 *  (Prisma's declared Chat type omits them; the controller needs records +
 *  datasource for the snake_case ChatInfo response). */
export type StartedChat = Chat & {
  records: ChatRecord[];
  datasource: Datasource | null;
};

/** Candidates from a stored clarify payload — defensive parse so a
 *  hand-corrupted row degrades to "no candidates" (the resume path then
 *  rejects table picks) instead of throwing mid-stream. */
function clarifyCandidates(
  clarify: Prisma.JsonValue | null,
): Array<{ table_id: number; table_name: string }> {
  if (
    clarify == null ||
    typeof clarify !== 'object' ||
    Array.isArray(clarify)
  ) {
    return [];
  }
  const raw = (clarify as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ table_id: number; table_name: string }> = [];
  for (const c of raw) {
    if (c == null || typeof c !== 'object' || Array.isArray(c)) continue;
    const { table_id, table_name } = c as {
      table_id?: unknown;
      table_name?: unknown;
    };
    if (typeof table_id === 'number' && typeof table_name === 'string') {
      out.push({ table_id, table_name });
    }
  }
  return out;
}

function clarifyCandidateIds(clarify: Prisma.JsonValue | null): number[] {
  return clarifyCandidates(clarify).map((c) => c.table_id);
}

/** The advisory `max_select` stored on the pending payload; null when the
 *  payload is corrupt/legacy. The frontend renders radio-style limits, but
 *  the resume endpoint enforces the same cap server-side. */
function clarifyMaxSelect(clarify: Prisma.JsonValue | null): number | null {
  if (
    clarify == null ||
    typeof clarify !== 'object' ||
    Array.isArray(clarify)
  ) {
    return null;
  }
  const raw = (clarify as { max_select?: unknown }).max_select;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : null;
}

function clarifyCandidateNames(
  clarify: Prisma.JsonValue | null,
): Map<number, string> {
  return new Map(
    clarifyCandidates(clarify).map((c) => [c.table_id, c.table_name]),
  );
}

/** A clarify candidate plus the actor-effective table semantic, when one
 *  exists. `comment` is kept for the deterministic gate's explicit-mention
 *  detection (needsClarify); the UI prefers `meaning` for display. */
type ClarifyOption = TableRecallCandidate & { meaning?: string };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly datasourceService: DatasourceService,
    private readonly aiQuestionService: AiQuestionService,
    private readonly generatorService: GeneratorService,
    private readonly sqlSafety: SqlSafetyService,
    private readonly rowPermissionService: RowPermissionService,
    private readonly terminologyService: TerminologyService,
    private readonly semanticService: SemanticService,
    private readonly metricService: MetricService,
    private readonly standardService: DataStandardService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // --- pipeline ----------------------------------------------------------

  /** Full NL2SQL pipeline: select_datasource (if needed) → generate_sql →
   *  safety → execute → generate_chart, streaming SSE events. A missing chat
   *  (or wrong oid) throws 404 before any record is created; every later
   *  failure becomes an `error`+`finish` event so the stream closes cleanly. */
  async *runPipeline(
    chatId: number,
    content: string,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    // Quick commands: `/regenerate <rid>`, `/analysis <rid>`, `/predict <rid>`
    // dispatch to their pipelines before any chat load, so each handler does
    // its own (404-throwing) chat lookup. Anything else is a normal question.
    const cmd = content
      .trim()
      .match(/^\/(regenerate|analysis|predict)\b\s*(\d+)?\s*$/);
    if (cmd) {
      const rid = cmd[2] ? +cmd[2] : null;
      if (rid == null) {
        // Command text isn't natural language — phrase the usage hint in the
        // profile language, not the command's (ASCII) detected language.
        yield* this.quickCmdError(
          chatMessages(this.profileLang()).quickCmdMissingId(cmd[1]),
        );
        return;
      }
      if (cmd[1] === 'regenerate') {
        yield* this.regenerate(chatId, rid, modelId);
        return;
      }
      if (cmd[1] === 'analysis') {
        yield* this.runAnalysis(chatId, rid, modelId);
        return;
      }
      yield* this.runPredict(chatId, rid, modelId);
      return;
    }

    const oid = this.currentOid();
    // Per-turn language: this reply (prompts + SSE frames) follows the
    // question's own language; the profile language only covers scripts we
    // don't recognize.
    const lang = this.detectLang(content);
    const msgs = chatMessages(lang);
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    if (!chat) throw new NotFoundException(msgs.chatNotFound(chatId));

    // NOTE: datasourceId lives on the Chat (bound once at select_datasource /
    // first question), not on each ChatRecord, so it isn't mirrored here.
    const record = await this.prisma.chatRecord.create({
      data: {
        chatId,
        oid,
        createBy: this.currentUid(),
        question: content,
      },
    });
    yield { type: 'id', data: { id: record.id } };
    yield { type: 'question', data: { question: content } };

    try {
      let datasourceId: number | null = chat.datasourceId;

      // select_datasource only when the chat has no bound datasource yet.
      if (datasourceId == null) {
        yield { type: 'info', data: { msg: msgs.selectDatasource } };
        const datasources = await this.datasourceService.findAll();
        const options = datasources.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description ?? undefined,
        }));
        const ctx = this.aiQuestionService.buildForSelectDatasource({
          question: content,
          datasources: options,
          lang,
        });
        let chosenId: number | null = null;
        const selLogId = await this.startLog(record.id, 'CHOOSE_DATASOURCE');
        let selReasoning = '';
        let selMessages: SerializedMessage[] | undefined;
        let selContent = '';
        let selTokenUsage: TokenUsage | undefined;
        try {
          for await (const ev of this.generatorService.selectDatasource(
            ctx,
            modelId,
          )) {
            if (ev.type === 'messages') {
              selMessages = ev.messages;
            } else if (ev.type === 'reasoning') {
              selReasoning += ev.delta;
              yield {
                type: 'datasource-result',
                data: { reasoning_content: ev.delta },
              };
            } else if (ev.type === 'content') {
              selContent += ev.delta;
              yield {
                type: 'datasource-result',
                data: { content: ev.delta },
              };
            } else if (ev.type === 'usage') {
              selTokenUsage = ev.usage;
            } else if (ev.type === 'result') {
              const r = ev.data as SelectDsResult | null;
              chosenId = r?.datasourceId ?? null;
            }
          }
          await this.endLog(selLogId, {
            reasoning: selReasoning,
            messages: this.appendAiMessage(selMessages, selContent),
            tokenUsage: selTokenUsage,
          });
        } catch (e) {
          await this.triggerLogError(selLogId);
          throw e;
        }
        if (chosenId == null) {
          yield* this.fail(record.id, msgs.datasourceNotSelected);
          return;
        }
        datasourceId = chosenId;
      }

      // Defensive guard (unreachable after a successful select_datasource)
      // plus TS narrowing: below this point datasourceId is a number.
      if (datasourceId == null) {
        yield* this.fail(record.id, msgs.noDatasource);
        return;
      }
      const ds = await this.datasourceService.findOne(datasourceId);
      const engine = engineFromDatasourceType(ds.type);
      if (!engine) {
        yield* this.fail(record.id, msgs.unsupportedEngine);
        return;
      }
      // Bind the resolved datasource + engine onto the chat once.
      if (chat.datasourceId !== datasourceId || !chat.engineType) {
        await this.prisma.chat.update({
          where: { id: chatId },
          data: { datasourceId, engineType: engine },
        });
      }
      yield {
        type: 'datasource',
        data: {
          id: datasourceId,
          datasource_name: ds.name,
          engine_type: engine,
        },
      };

      yield* this.runCore(
        record,
        chatId,
        content,
        datasourceId,
        engine,
        chat.title,
        chat.origin ?? 0,
        lang,
        modelId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`pipeline failed for chat #${chatId}: ${msg}`);
      yield { type: 'error', data: { content: msg } };
      await this.finishRecord(record.id, msg);
      yield { type: 'finish', data: {} };
    }
  }

  /** Re-run the core pipeline from a stored question into a new ChatRecord
   *  linked back to the source via regenerateRecordId. select_datasource is
   *  not re-run — the chat must already have a bound datasource. */
  async *regenerate(
    chatId: number,
    recordId: number,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    // Pre-question 404s use the profile language (no question text yet).
    if (!chat) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).chatNotFound(chatId),
      );
    }
    const source = await this.prisma.chatRecord.findFirst({
      where: {
        id: recordId,
        chatId,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
    });
    if (!source) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).recordNotFound(recordId),
      );
    }
    // The re-run keeps the source question's language.
    const lang = this.detectLang(source.question);
    const msgs = chatMessages(lang);

    const record = await this.prisma.chatRecord.create({
      data: {
        chatId,
        oid,
        createBy: this.currentUid(),
        question: source.question,
        regenerateRecordId: recordId,
      },
    });
    yield { type: 'id', data: { id: record.id } };
    // Signal the regen source so the frontend can link back.
    yield {
      type: 'regenerate_record_id',
      data: { regenerate_record_id: recordId },
    };
    yield { type: 'question', data: { question: source.question } };

    try {
      if (chat.datasourceId == null) {
        yield* this.fail(record.id, msgs.datasourceRequired);
        return;
      }
      const ds = await this.datasourceService.findOne(chat.datasourceId);
      const engine = engineFromDatasourceType(ds.type);
      if (!engine) {
        yield* this.fail(record.id, msgs.unsupportedEngine);
        return;
      }
      yield {
        type: 'datasource',
        data: {
          id: chat.datasourceId,
          datasource_name: ds.name,
          engine_type: engine,
        },
      };
      yield* this.runCore(
        record,
        chatId,
        source.question,
        chat.datasourceId,
        engine,
        chat.title,
        chat.origin ?? 0,
        lang,
        modelId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`regenerate failed for chat #${chatId}: ${msg}`);
      yield { type: 'error', data: { content: msg } };
      await this.finishRecord(record.id, msg);
      yield { type: 'finish', data: {} };
    }
  }

  /** Resume a clarify-paused record with the user's answer (MetaDataImprove
   *  M1 rule 1). The SAME ChatRecord continues (no new record): picked tables
   *  force the schema subset; supplement text enriches the question (recall
   *  re-runs with it); skip re-runs with the pre-clarify behavior. The answer
   *  is persisted BEFORE streaming so an abandoned stream still records it. */
  async *resumeClarified(
    recordId: number,
    answer: { tableIds?: number[]; text?: string; skip?: boolean },
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: recordId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
    });
    // Pre-stream 404s use the profile language (no question text yet).
    if (!record) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).recordNotFound(recordId),
      );
    }
    if (record.clarifyStatus !== 'pending') {
      throw new BadRequestException(
        chatMessages(this.profileLang()).recordNotClarifying(recordId),
      );
    }

    // Resolve the answer against the candidates stored in the pending payload
    // (an id outside the offered pool is rejected — it could narrow the schema
    // to a table the gate never offered).
    const candidateIds = clarifyCandidateIds(record.clarify);
    const wanted = (answer.tableIds ?? []).filter((id) =>
      candidateIds.includes(id),
    );
    const maxSelect = clarifyMaxSelect(record.clarify);
    if (maxSelect != null && wanted.length > maxSelect) {
      throw new BadRequestException(
        chatMessages(this.profileLang()).clarifyTooManyTables(maxSelect),
      );
    }
    const text = (answer.text ?? '').trim();
    if (!answer.skip && wanted.length === 0 && !text) {
      throw new BadRequestException(
        chatMessages(this.profileLang()).clarifyAnswerRequired,
      );
    }
    if ((answer.tableIds ?? []).length > 0 && wanted.length === 0) {
      throw new BadRequestException(
        chatMessages(this.profileLang()).clarifyTablesInvalid,
      );
    }

    const namesById = clarifyCandidateNames(record.clarify);
    const persisted = {
      table_ids: wanted.length > 0 ? wanted : undefined,
      table_names:
        wanted.length > 0
          ? wanted.map((id) => namesById.get(id) ?? id)
          : undefined,
      text: text || undefined,
      skip: answer.skip || undefined,
    };
    const status = answer.skip ? 'skipped' : 'answered';
    // The clarify round is settled even if this stream dies — never re-ask.
    await this.prisma.chatRecord.update({
      where: { id: record.id },
      data: {
        clarifyAnswer: persisted,
        clarifyStatus: status,
      },
    });

    // The resume follows the source question's language.
    const lang = this.detectLang(record.question);
    const msgs = chatMessages(lang);
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(record.chatId, oid),
    });
    if (!chat) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).chatNotFound(record.chatId),
      );
    }
    // Supplement text joins the question for THIS run (the stored question
    // stays immutable; later turns see the answer via getHistory).
    const content = text ? `${record.question}\n${text}` : record.question;

    yield { type: 'id', data: { id: record.id } };
    try {
      if (chat.datasourceId == null) {
        yield* this.fail(record.id, msgs.datasourceRequired);
        return;
      }
      const ds = await this.datasourceService.findOne(chat.datasourceId);
      const engine = engineFromDatasourceType(ds.type);
      if (!engine) {
        yield* this.fail(record.id, msgs.unsupportedEngine);
        return;
      }
      yield* this.runCore(
        // clarifyStatus reflects the just-persisted answer so the gate's
        // round budget stays spent (never re-ask after an answer).
        { ...record, clarifyStatus: status },
        record.chatId,
        content,
        chat.datasourceId,
        engine,
        chat.title,
        chat.origin ?? 0,
        lang,
        modelId,
        {
          forcedTableIds: wanted.length > 0 ? wanted : undefined,
          skipClarify: answer.skip || undefined,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `clarify resume failed for record #${recordId}: ${msg}`,
      );
      yield { type: 'error', data: { content: msg } };
      await this.finishRecord(record.id, msg);
      yield { type: 'finish', data: {} };
    }
  }

  /** Generate a free-text analysis of an existing record's SQL result. The
   *  analysis text is persisted in-place on the source ChatRecord(:rid) (no
   *  new record). generate_analysis returns prose, so content deltas stream
   *  live as `analysis-result{content}` and reasoning as `analysis-result{
   *  reasoning_content}`; `analysis_finish{}` terminates. A missing chat/
   *  record throws 404 pre-stream; later failures → error+analysis_finish. */
  async *runAnalysis(
    chatId: number,
    rid: number,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    // Pre-question 404s use the profile language (no question text yet).
    if (!chat) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).chatNotFound(chatId),
      );
    }
    const source = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        chatId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
    });
    if (!source) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).recordNotFound(rid),
      );
    }
    // The analysis follows the source question's language.
    const lang = this.detectLang(source.question);
    const msgs = chatMessages(lang);
    yield { type: 'id', data: { id: rid } };

    try {
      const ctx = await this.buildSecondaryCtx(
        chat,
        source,
        chatId,
        'ANALYSIS',
        lang,
      );
      if (typeof ctx === 'string') {
        yield { type: 'error', data: { content: ctx } };
        await this.finishRecord(rid, ctx);
        yield { type: 'analysis_finish', data: {} };
        return;
      }
      yield { type: 'info', data: { msg: msgs.generateAnalysis } };
      let analysis: AnalysisResult | null = null;
      const logId = await this.startLog(rid, 'ANALYSIS');
      let reasoning = '';
      let preStream: SerializedMessage[] | undefined;
      let content = '';
      let tokenUsage: TokenUsage | undefined;
      try {
        for await (const ev of this.generatorService.generateAnalysis(
          ctx,
          modelId,
        )) {
          if (ev.type === 'messages') {
            preStream = ev.messages;
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta;
            yield {
              type: 'analysis-result',
              data: { reasoning_content: ev.delta },
            };
          } else if (ev.type === 'content') {
            content += ev.delta;
            // Analysis content is showable prose (not JSON) — stream it live.
            yield { type: 'analysis-result', data: { content: ev.delta } };
          } else if (ev.type === 'usage') {
            tokenUsage = ev.usage;
          } else if (ev.type === 'result') {
            analysis = (ev.data as AnalysisResult | null) ?? null;
          }
        }
        await this.endLog(logId, {
          reasoning,
          messages: this.appendAiMessage(preStream, content),
          tokenUsage,
        });
      } catch (e) {
        await this.triggerLogError(logId);
        throw e;
      }
      if (!analysis) {
        yield { type: 'error', data: { content: msgs.analysisNoResult } };
        await this.finishRecord(rid, msgs.analysisNoResult);
        yield { type: 'analysis_finish', data: {} };
        return;
      }
      await this.prisma.chatRecord.update({
        where: { id: rid },
        data: { analysis: analysis.analysis },
      });
      yield { type: 'analysis_finish', data: {} };
      this.audit
        .record({
          module: OperationModule.CHAT,
          type: OperationType.CREATE,
          status: 'success',
          detail: '生成分析',
          resources: [{ name: 'chat', originId: chatId }],
        })
        .catch((e) =>
          this.logger.warn(
            `audit failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`analysis failed for record #${rid}: ${msg}`);
      yield { type: 'error', data: { content: msg } };
      await this.finishRecord(rid, msg);
      yield { type: 'analysis_finish', data: {} };
    }
  }

  /** Generate a structured predict (prose + predict_data) for an existing
   *  record's SQL result. Persisted in-place on the source ChatRecord(:rid).
   *  `predict-result` streams content + reasoning_content; success →
   *  `predict-success` (frontend then GETs predict_data) + `predict_finish`;
   *  failure → `predict-failed` + `predict_finish` (thrown adds `error` first). */
  async *runPredict(
    chatId: number,
    rid: number,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    // Pre-question 404s use the profile language (no question text yet).
    if (!chat) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).chatNotFound(chatId),
      );
    }
    const source = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        chatId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
    });
    if (!source) {
      throw new NotFoundException(
        chatMessages(this.profileLang()).recordNotFound(rid),
      );
    }
    // The prediction follows the source question's language.
    const lang = this.detectLang(source.question);
    const msgs = chatMessages(lang);
    yield { type: 'id', data: { id: rid } };

    try {
      const ctx = await this.buildSecondaryCtx(
        chat,
        source,
        chatId,
        'PREDICT_DATA',
        lang,
      );
      if (typeof ctx === 'string') {
        yield { type: 'error', data: { content: ctx } };
        await this.finishRecord(rid, ctx);
        yield { type: 'predict-failed', data: {} };
        yield { type: 'predict_finish', data: {} };
        return;
      }
      yield { type: 'info', data: { msg: msgs.generatePredict } };
      let predict: PredictResult | null = null;
      const logId = await this.startLog(rid, 'PREDICT_DATA');
      let reasoning = '';
      let preStream: SerializedMessage[] | undefined;
      let content = '';
      let tokenUsage: TokenUsage | undefined;
      try {
        for await (const ev of this.generatorService.generatePredict(
          ctx,
          modelId,
        )) {
          if (ev.type === 'messages') {
            preStream = ev.messages;
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta;
            yield {
              type: 'predict-result',
              data: { reasoning_content: ev.delta },
            };
          } else if (ev.type === 'content') {
            content += ev.delta;
            yield { type: 'predict-result', data: { content: ev.delta } };
          } else if (ev.type === 'usage') {
            tokenUsage = ev.usage;
          } else if (ev.type === 'result') {
            predict = (ev.data as PredictResult | null) ?? null;
          }
        }
        await this.endLog(logId, {
          reasoning,
          messages: this.appendAiMessage(preStream, content),
          tokenUsage,
        });
      } catch (e) {
        await this.triggerLogError(logId);
        throw e;
      }
      if (!predict) {
        await this.finishRecord(rid, msgs.predictNoResult);
        yield { type: 'predict-failed', data: {} };
        yield { type: 'predict_finish', data: {} };
        return;
      }
      await this.prisma.chatRecord.update({
        where: { id: rid },
        data: {
          predict: predict.predict,
          predictData: predict.predictData as Prisma.InputJsonValue,
        },
      });
      // The parsed predict payload is persisted; the frontend GETs it via
      // /chat/record/:rid/predict_data on receipt of predict-success.
      yield { type: 'predict-success', data: {} };
      yield { type: 'predict_finish', data: {} };
      this.audit
        .record({
          module: OperationModule.CHAT,
          type: OperationType.CREATE,
          status: 'success',
          detail: '生成预测',
          resources: [{ name: 'chat', originId: chatId }],
        })
        .catch((e) =>
          this.logger.warn(
            `audit failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`predict failed for record #${rid}: ${msg}`);
      yield { type: 'error', data: { content: msg } };
      await this.finishRecord(rid, msg);
      yield { type: 'predict-failed', data: {} };
      yield { type: 'predict_finish', data: {} };
    }
  }

  /** Build the result-phase context (reused by analysis + predict) from an
   *  already-loaded chat + source record. Returns an error string when a
   *  precondition fails (no SQL/datasource/engine), else the AiModelQuestion.
   *  Never yields — callers emit id/info/fail around it. */
  private async buildSecondaryCtx(
    chat: { datasourceId: number | null },
    source: {
      question: string;
      sql: string | null;
      sqlExecResult: unknown;
      /** Analysis re-retrieves terminology with the record's
       *  saved keywords instead of re-matching on the raw question. */
      expandedKeywords?: string | null;
      extractedKeywords?: string | null;
    },
    chatId: number,
    /** ANALYSIS (runAnalysis) or PREDICT_DATA (runPredict) — flows to
     *  buildForResult → buildSqlContext → findCustomPrompts so the matching
     *  custom-prompt body is injected into the secondary system prompt. */
    customPromptType: string,
    /** Reply language for the turn (detected from source.question by the
     *  caller) — flows to buildForResult and phrases the error strings. */
    lang: string,
  ): Promise<string | AiModelQuestion> {
    const msgs = chatMessages(lang);
    if (!source.sql || !source.sqlExecResult) {
      return msgs.secondaryNoResult;
    }
    if (chat.datasourceId == null) return msgs.datasourceRequired;
    const ds = await this.datasourceService.findOne(chat.datasourceId);
    const engine = engineFromDatasourceType(ds.type);
    if (!engine) return msgs.unsupportedEngine;
    // 3fd6fa86 (P1S4): the record's saved keywords drive BOTH the table
    // recall here and the terminology re-retrieval in buildSqlContext
    // (upstream generate_analysis re-matches on the saved keywords).
    const savedKeywords = source.expandedKeywords ?? source.extractedKeywords;
    // Task-start retrieval snapshot (ADR 0001): one config read drives BOTH
    // the table recall and the terminology/data-training retrieval inside
    // buildForResult — an admin save mid-task must not split the snapshot.
    const cfg = await resolveEmbeddingConfig(this.prisma);
    const tableIds = await this.recallNarrowedSchema(
      chat.datasourceId,
      source.question,
      { keywords: savedKeywords ?? null, config: cfg },
    );
    const history = await this.getHistory(chatId, this.historyRounds());
    return this.aiQuestionService.buildForResult({
      question: source.question,
      datasourceId: chat.datasourceId,
      engine,
      sql: source.sql,
      sqlResult: JSON.stringify(source.sqlExecResult),
      history,
      tableIds,
      customPromptType,
      knowledgeQuery: savedKeywords ?? undefined,
      embeddingConfig: cfg,
      lang,
    });
  }

  /** Yield an error + finish pair for a quick-command that can't run (no rid).
   *  No ChatRecord is created. Sync generator (no await) — `yield*`-delegated
   *  from the async pipeline. */
  private *quickCmdError(message: string): Generator<ChatSseEvent> {
    yield { type: 'error', data: { content: message } };
    yield { type: 'finish', data: {} };
  }

  /** The shared core steps 4–11 (recall → clarify-gate → generate_sql →
   *  safety → execute → generate_chart → persist → finish). Both runPipeline
   *  (after datasource resolution), regenerate and resumeClarified delegate
   *  here. Assumes datasourceId + engine are already resolved by the caller. */
  private async *runCore(
    record: { id: number; clarifyStatus?: string | null },
    chatId: number,
    content: string,
    datasourceId: number,
    engine: EngineType,
    chatTitle: string,
    chatOrigin: number,
    /** Reply language — detected from `content` by the caller; drives every
     *  prompt's {lang} and all SSE frames in this run. */
    lang: string,
    modelId?: number,
    /** Resume context (resumeClarified): forcedTableIds = the user picked the
     *  schema subset (skips keyword extraction + recall + the clarify gate);
     *  skipClarify = the user chose "just generate" (recall runs, gate stays
     *  closed for this record). */
    opts?: { forcedTableIds?: number[]; skipClarify?: boolean },
  ): AsyncGenerator<ChatSseEvent> {
    const msgs = chatMessages(lang);
    // Task-start retrieval snapshot (9e6070e8 ADR 0001): one read per task,
    // rules stay stable for the run's duration.
    const cfg = await resolveEmbeddingConfig(this.prisma);
    // A forced table subset means the user already chose the tables — keyword
    // extraction (an LLM call) and recall would both be wasted.
    const forcedTableIds = opts?.forcedTableIds;
    // 3fd6fa86→bc3403b8: LLM keyword extraction + terminology expansion feed
    // the fusion table ranking; failures degrade to the raw question (we do
    // NOT reject non-data queries like upstream — no behavior change).
    let expandedKeywords: string | null = null;
    if (cfg.keywordEnabled && !forcedTableIds) {
      const extracted = await this.extractKeywords(
        record.id,
        chatId,
        content,
        engine,
        lang,
        modelId,
      );
      if (extracted) {
        expandedKeywords = await this.terminologyService.expandWithTerminology(
          extracted,
          this.currentOid(),
        );
        await this.prisma.chatRecord.update({
          where: { id: record.id },
          data: {
            extractedKeywords: extracted,
            expandedKeywords,
          },
        });
      }
    }
    // Keyword-fused table pre-filter (degrades to all-checked when
    // embedding/vector unavailable — recallTables returns []).
    let tableIds = forcedTableIds
      ? forcedTableIds
      : await this.recallNarrowedSchema(datasourceId, content, {
          keywords: expandedKeywords,
          config: cfg,
        });

    // Loaded once, reused by the clarify gate, rule-2 narrowing and the
    // need_clarify candidate mapping below.
    const dsTables = await this.datasourceService.findOne(datasourceId);
    const nameById = new Map(dsTables.tables.map((t) => [t.id, t.tableName]));
    /** The FK edge graph (M3.1: the relation editor's X6 cells resolved
     *  through synced row ids) — drives join-bridge expansion below. */
    const relationEdges = normalizeTableRelation(
      dsTables.tableRelation,
      relationIdNamesOf(dsTables.tables),
    );
    const checkedTableNames = new Set(
      dsTables.tables.filter((t) => t.checked).map((t) => t.tableName),
    );
    const tableByName = new Map(dsTables.tables.map((t) => [t.tableName, t]));
    const tableById = new Map(dsTables.tables.map((t) => [t.id, t]));
    /** The clarify-pool candidates in recall rank order (every checked table
     *  when recall degraded to "stuff everything"). */
    const clarifyPool = (
      tableIds
        ? tableIds
            .map((id) => dsTables.tables.find((t) => t.id === id))
            .filter((t): t is (typeof dsTables.tables)[number] => !!t)
        : dsTables.tables.filter((t) => t.checked)
    ).map((t) => ({
      id: t.id,
      tableName: t.tableName,
      comment: t.customComment || t.tableComment || '',
    }));

    // --- join-topology hints (MetaDataImprove M3) ------------------------
    // Bridge tables connecting two pool candidates within ≤2 hops join the
    // OPTIONS the user can pick from — they can select the full join chain
    // in one clarify answer. The gate itself keeps counting the ORIGINAL
    // pool: a bridge is a hint, not additional ambiguity.
    const clarifyOptions = [
      ...clarifyPool,
      ...joinBridgeTables(
        relationEdges,
        clarifyPool.map((c) => c.tableName),
        checkedTableNames,
      )
        .filter((n) => !clarifyPool.some((c) => c.tableName === n))
        .map((n) => tableByName.get(n))
        .filter((t): t is (typeof dsTables.tables)[number] => !!t)
        .map((t) => ({
          id: t.id,
          tableName: t.tableName,
          comment: t.customComment || t.tableComment || '',
        })),
    ];

    // --- rule 2: semantic narrowing (MetaDataImprove M2) ------------------
    // When candidate tables carry effective semantics ("valid semantics"),
    // stuff only the top semantic.max_tables of the covered ones (default 1);
    // the LLM may still request more via the need_clarify contract. Runs
    // BEFORE the M1 gate: valid semantics answer the ambiguity the gate would
    // ask about. Skipped when the user hand-picked tables (forcedTableIds) —
    // their explicit choice wins. Join paths to uncovered tables are covered
    // by the M3 bridge expansion below (join-path.ts).
    let semanticAnnotations: SemanticAnnotations | undefined;
    /** Table names the current `semanticAnnotations` were resolved for. Lets
     *  the final decoration step below reuse the candidate load instead of
     *  hitting the semantic tables twice per run. */
    let semanticAnnotatedNames: string[] | undefined;
    /** Candidate-pool semantics loaded by rule 2, kept separately because the
     *  final decoration below may replace `semanticAnnotations` with the
     *  stuffed subset. Drives the candidate_tables prompt block + clarify
     *  candidate meanings. */
    let clarifyAnnotations: SemanticAnnotations | undefined;
    let clarifyAnnotatedNames: string[] | undefined;
    let semanticNarrowed = false;
    if (
      cfg.semanticEnabled &&
      !forcedTableIds &&
      tableIds &&
      tableIds.length > cfg.semanticMaxTables
    ) {
      const candidateNames = tableIds.map((id) => nameById.get(id) ?? `#${id}`);
      const annotations = await this.semanticService.effectiveAnnotations(
        datasourceId,
        candidateNames,
      );
      // Keep the candidate load even when it does not narrow: the final
      // decoration step reuses it whenever the stuffed set is a subset.
      semanticAnnotations = annotations;
      semanticAnnotatedNames = candidateNames;
      clarifyAnnotations = annotations;
      clarifyAnnotatedNames = candidateNames;
      const coveredIds = tableIds.filter(
        (id) => annotations.tableMeanings[nameById.get(id) ?? ''] !== undefined,
      );
      if (coveredIds.length >= cfg.semanticMaxTables) {
        tableIds = coveredIds.slice(0, cfg.semanticMaxTables);
        semanticNarrowed = true;
      }
    }

    // --- clarify gate (MetaDataImprove M1 rule 1) ------------------------
    // The no-valid-semantics fallback: ≥ threshold candidate tables about to
    // be stuffed, nothing explicitly mentioned and rule 2 did not resolve it
    // → pause and ask the user instead of guessing — one wrong table breaks
    // the join. Known limitation: multi-turn follow-ups can also trip the
    // gate; mitigate via clarify.enabled / skip.
    if (!forcedTableIds && !semanticNarrowed && !opts?.skipClarify) {
      const asked = record.clarifyStatus ? 1 : 0;
      if (
        needsClarify(clarifyPool, content, {
          enabled: cfg.clarifyEnabled,
          tableThreshold: cfg.clarifyTableThreshold,
          rounds: asked,
          maxRounds: cfg.clarifyMaxRounds,
        })
      ) {
        const gateOptions = await this.clarifyOptionsWithMeanings(
          datasourceId,
          clarifyOptions,
          cfg,
          clarifyAnnotations,
          clarifyAnnotatedNames,
        );
        yield* this.pauseForClarify(
          record.id,
          content,
          gateOptions,
          cfg.clarifyMaxSelect,
        );
        return;
      }
    }

    // --- metric definitions + naming rules (MetaDataImprove M4) ----------
    // A matched metric outranks both recall ranking and the rule-2 cut: its
    // atomic tables are force-stuffed (checked tables only — an unchecked
    // binding still injects its caliber and the need_clarify contract covers
    // the missing table) so what the prompt teaches is computable from the
    // schema. Runs after the clarify gate and BEFORE the M3 bridge expansion
    // so join connectors see the final set. Dictionary failures degrade to
    // no injection (enrichment, never a hard dependency — vector-recall
    // degradation rule).
    let metricText = '';
    let namingText = '';
    if (cfg.metricEnabled || cfg.namingEnabled) {
      try {
        if (cfg.metricEnabled) {
          const matched = await this.metricService.matchDefinitions(
            datasourceId,
            content,
            cfg.metricMaxDefinitions,
          );
          if (matched.text) {
            metricText = matched.text;
            if (tableIds) {
              const extraIds = matched.atomicTableNames
                .filter((n) => checkedTableNames.has(n))
                .map((n) => tableByName.get(n)?.id)
                .filter(
                  (id): id is number => id != null && !tableIds!.includes(id),
                );
              if (extraIds.length > 0) tableIds = [...tableIds, ...extraIds];
            }
          }
        }
        if (cfg.namingEnabled) {
          namingText = await this.standardService.namingTemplateFor(
            content,
            cfg.metricMaxDefinitions,
          );
        }
      } catch (e) {
        this.logger.warn(
          `metric definitions skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // --- join-bridge expansion (MetaDataImprove M3) ----------------------
    // A narrowed schema (recall top-K / rule 2 / a clarify pick) may hold two
    // tables whose only join runs through a THIRD table recall never
    // surfaced. BFS ≤2 hops stuffs those connectors (checked tables only) so
    // the LLM writes the real join instead of guessing one; buildMSchema
    // then emits their FK lines because both endpoints are in the schema.
    if (tableIds) {
      const stuffed = tableIds;
      const bridgeIds = joinBridgeTables(
        relationEdges,
        stuffed.map((id) => nameById.get(id)),
        checkedTableNames,
      )
        .map((n) => tableByName.get(n)?.id)
        .filter((id): id is number => id != null && !stuffed.includes(id));
      if (bridgeIds.length > 0) tableIds = [...stuffed, ...bridgeIds];
    }

    // --- clarify candidate prompt + preselect pool (MetaDataImprove M1) ----
    // The final stuffed set can include tables added AFTER clarifyOptions was
    // built (metric force-stuff, final bridge expansion). Bring those into the
    // pickable pool so a need_clarify answer cannot silently drop the schema
    // this run already had. Only tables omitted from the schema are rendered
    // in `{candidate_tables}`; degrade-to-all-checked (tableIds undefined)
    // skips the block because those tables are already in the schema.
    const stuffedIds = new Set(
      tableIds ?? dsTables.tables.filter((t) => t.checked).map((t) => t.id),
    );
    const clarifyOptionIds = new Set(clarifyOptions.map((o) => o.id));
    const needClarifyOptions: ClarifyOption[] = [...clarifyOptions];
    for (const id of tableIds ?? []) {
      if (clarifyOptionIds.has(id)) continue;
      const row = tableById.get(id);
      if (!row || !row.checked) continue;
      needClarifyOptions.push({
        id: row.id,
        tableName: row.tableName,
        comment: row.customComment || row.tableComment || '',
      });
      clarifyOptionIds.add(id);
    }
    const decoratedClarifyOptions = needClarifyOptions.map((o) => {
      const meaning = clarifyAnnotations?.tableMeanings[o.tableName];
      return meaning ? { ...o, meaning } : o;
    });
    // Only the first pass can pause again (one clarify round today); skip the
    // extra prompt block once an answer exists.
    const candidateTablesText =
      !record.clarifyStatus && tableIds
        ? this.renderCandidateTables(decoratedClarifyOptions, stuffedIds)
        : '';

    // --- always-on semantic decoration (MetaDataImprove M2) --------------
    // Rule-2 narrowing is a gate, not the only reason to read semantics: a
    // single recalled table, a user-picked subset, metric force-stuffing and
    // bridge expansion all still benefit from table meanings, field notes and
    // cached dimension enums. Resolve once for the FINAL stuffed set, reusing
    // the pre-gate candidate load when it already covers every final table.
    if (cfg.semanticEnabled) {
      const finalNames = tableIds
        ? tableIds.map((id) => nameById.get(id)).filter((n): n is string => !!n)
        : [...checkedTableNames];
      const loaded = new Set(semanticAnnotatedNames ?? []);
      if (
        finalNames.length > 0 &&
        (!semanticAnnotations || finalNames.some((n) => !loaded.has(n)))
      ) {
        semanticAnnotations = await this.semanticService.effectiveAnnotations(
          datasourceId,
          finalNames,
        );
        semanticAnnotatedNames = finalNames;
      }
    }

    const history = await this.getHistory(chatId, this.historyRounds());

    // --- generate SQL --------------------------------------------------
    yield { type: 'info', data: { msg: msgs.generateSql } };
    const sqlCtx = await this.aiQuestionService.buildSqlContext({
      question: content,
      datasourceId,
      engine,
      history,
      tableIds,
      customPromptType: 'GENERATE_SQL',
      embeddingConfig: cfg,
      lang,
      semantics: semanticAnnotations,
      metrics: metricText,
      namingRules: namingText,
      candidateTables: candidateTablesText || undefined,
    });
    let sqlResult: SqlGenResult | null = null;
    // startLog INSERTs the row before the stream drains, so a
    // mid-stream throw still leaves an audit trail (gap closed; the old
    // single-INSERT persistLog created no row if the step threw first).
    const sqlLogId = await this.startLog(record.id, 'GENERATE_SQL');
    let sqlReasoning = '';
    // Capture the pre-stream messages snapshot + accumulate the
    // streamed content + the final-chunk token usage for endLog.
    let sqlMessages: SerializedMessage[] | undefined;
    let sqlContent = '';
    let sqlTokenUsage: TokenUsage | undefined;
    try {
      for await (const ev of this.generatorService.generateSql(
        sqlCtx,
        modelId,
      )) {
        if (ev.type === 'messages') {
          sqlMessages = ev.messages;
        } else if (ev.type === 'reasoning') {
          sqlReasoning += ev.delta;
          yield { type: 'sql-result', data: { reasoning_content: ev.delta } };
        } else if (ev.type === 'content') {
          sqlContent += ev.delta;
          yield { type: 'sql-result', data: { content: ev.delta } };
        } else if (ev.type === 'usage') {
          sqlTokenUsage = ev.usage;
        } else if (ev.type === 'result') {
          sqlResult = (ev.data as SqlGenResult | null) ?? null;
        }
      }
    } catch (e) {
      await this.triggerLogError(sqlLogId);
      throw e;
    }

    // --- LLM-declared insufficiency (rule 2 need_clarify) -----------------
    // The narrowed schema cannot answer; instead of forcing a wrong query the
    // LLM asks for more tables. Honored ONLY on a first pass — after the user
    // already picked tables / skipped, re-asking would loop, so it fails
    // honestly instead. The LLM call itself completed fine — endLog (not
    // triggerLogError) so the log row closes cleanly.
    if (sqlResult?.needClarify) {
      await this.endLog(sqlLogId, {
        reasoning: sqlReasoning,
        messages: this.appendAiMessage(sqlMessages, sqlContent),
        tokenUsage: sqlTokenUsage,
      });
      if (record.clarifyStatus) {
        yield* this.fail(record.id, msgs.sqlSchemaInsufficient);
        return;
      }
      const answerOptions = await this.clarifyOptionsWithMeanings(
        datasourceId,
        needClarifyOptions,
        cfg,
        clarifyAnnotations,
        clarifyAnnotatedNames,
      );
      const matched = matchSuggestedTableIds(
        Array.isArray(sqlResult.tables) ? sqlResult.tables : [],
        answerOptions,
      );
      // Preselect the tables this run already stuffed + the LLM's additions so
      // resuming with picks does not drop the current schema. When the stuffed
      // set alone exceeds max_select it cannot be represented, so only the
      // LLM's picks are suggested. Advisory: resume still enforces max_select.
      const stuffedOptionIds = answerOptions
        .filter((o) => stuffedIds.has(o.id))
        .map((o) => o.id);
      const suggestedTableIds =
        matched.length === 0
          ? undefined
          : (stuffedOptionIds.length <= cfg.clarifyMaxSelect
              ? [...new Set([...stuffedOptionIds, ...matched])]
              : matched
            ).slice(0, cfg.clarifyMaxSelect);
      yield* this.pauseForClarify(
        record.id,
        content,
        answerOptions,
        cfg.clarifyMaxSelect,
        sqlResult.reason,
        suggestedTableIds,
      );
      return;
    }

    if (!sqlResult || !sqlResult.success || !sqlResult.sql) {
      const msg = !sqlResult
        ? msgs.sqlGenNoResult
        : !sqlResult.success
          ? msgs.sqlGenFailed
          : msgs.sqlEmpty;
      await this.triggerLogError(sqlLogId, 'GENERATE_SQL');
      yield* this.fail(record.id, msg);
      return;
    }
    let sql = sqlResult.sql;
    // The SQL-gen log tag. Becomes GENERATE_SQL_WITH_PERMISSIONS when
    // the row-permission filter re-gen runs (the filter merges per-table WHERE
    // fragments into the SQL before execution). The started row's
    // operate is overridden via endLog/triggerLogError when the filter runs.
    let sqlOperate = 'GENERATE_SQL';
    const brief = sqlResult.brief || '';
    await this.prisma.chatRecord.update({
      where: { id: record.id },
      data: {
        sql,
        sqlAnswer: brief || null,
        brief: brief || null,
        chartType: sqlResult.chartType || null,
      },
    });
    yield { type: 'sql', data: { content: sql } };
    if (brief) yield { type: 'brief', data: { brief } };
    // Adopt the brief as the chat title when it's still the default.
    if (
      (chatTitle === '新对话' || chatTitle === tr('chat.default_title')) &&
      brief
    ) {
      await this.prisma.chat.update({
        where: { id: chatId },
        data: { title: brief.slice(0, 50), brief },
      });
    }

    // --- SQL safety ----------------------------------------------------
    const ds = await this.datasourceService.findOne(datasourceId);
    const allowedTables = ds.tables
      .filter((t) => t.checked)
      .map((t) => t.tableName);
    const safety = this.sqlSafety.validate(sql, allowedTables, ds.type);
    if (!safety.ok) {
      await this.triggerLogError(sqlLogId, sqlOperate);
      yield* this.fail(record.id, safety.reason ?? msgs.sqlSafetyFailed);
      return;
    }

    // --- row-permission filter re-gen ---------------------------------
    // (not assistant or is_page_embedded) and
    // is_normal_user → drain generateFilter (LLM merges the per-table WHERE
    // fragments into the SQL) and execute the re-generated SQL. Admin (uid 1)
    // + MCP-assistant origin (chatOrigin === 1) bypass. Filter reasoning
    // accumulates into sqlReasoning; filter content deltas are NOT streamed to
    // the frontend (the filtered SQL is delivered via the re-yielded `sql` event).
    const currentUser = RequestContext.getUser();
    // The origin guard short-circuits first so the service
    // lookup is skipped entirely for MCP-assistant turns (chatOrigin === 1).
    if (
      currentUser &&
      chatOrigin !== 1 &&
      this.rowPermissionService.isNormalUser(currentUser)
    ) {
      const sqlTables = this.sqlSafety.extractTableNames(sql, ds.type);
      const filters = await this.rowPermissionService.getRowFilters(
        currentUser,
        ds,
        sqlTables,
      );
      if (filters.length > 0) {
        const filterCtx = this.aiQuestionService.buildFilterContext({
          engine,
          sql,
          filter: JSON.stringify(filters),
          lang,
        });
        let filterResult: FilterGenResult | null = null;
        try {
          for await (const ev of this.generatorService.generateFilter(
            filterCtx,
            modelId,
          )) {
            // The filter re-gen also emits messages/usage — fold
            // its reasoning into the same sqlLog, ignore its messages snapshot
            // (the filter is a sub-step of GENERATE_SQL, not a separate row).
            if (ev.type === 'reasoning') {
              sqlReasoning += ev.delta;
            } else if (ev.type === 'content') {
              sqlContent += ev.delta;
            } else if (ev.type === 'usage' && !sqlTokenUsage) {
              // keep the GENERATE_SQL usage (first); filter usage is secondary.
              sqlTokenUsage = ev.usage;
            } else if (ev.type === 'result') {
              filterResult = (ev.data as FilterGenResult | null) ?? null;
            }
          }
        } catch (e) {
          await this.triggerLogError(sqlLogId, 'GENERATE_SQL_WITH_PERMISSIONS');
          throw e;
        }
        if (filterResult && !filterResult.success) {
          const msg = filterResult.message || msgs.filterGenFailed;
          await this.triggerLogError(sqlLogId, 'GENERATE_SQL_WITH_PERMISSIONS');
          yield* this.fail(record.id, msg);
          return;
        }
        if (filterResult && filterResult.success && filterResult.sql) {
          // Re-safety the LLM-merged SQL — it could hallucinate new tables or
          // alter structure. Same allowedTables as the original SQL.
          const reSafety = this.sqlSafety.validate(
            filterResult.sql,
            allowedTables,
            ds.type,
          );
          if (!reSafety.ok) {
            await this.triggerLogError(
              sqlLogId,
              'GENERATE_SQL_WITH_PERMISSIONS',
            );
            yield* this.fail(
              record.id,
              reSafety.reason ?? msgs.filterSafetyFailed,
            );
            return;
          }
          sql = filterResult.sql;
          sqlOperate = 'GENERATE_SQL_WITH_PERMISSIONS';
          await this.prisma.chatRecord.update({
            where: { id: record.id },
            data: { sql },
          });
          yield { type: 'sql', data: { content: sql } };
        }
        // filterResult null (unparseable) → fall through with original SQL
      }
    }

    // --- execute SQL ---------------------------------------------------
    yield { type: 'info', data: { msg: msgs.execSql } };
    let queryResult: QueryResult;
    try {
      queryResult = await this.datasourceService.execSql(datasourceId, sql);
    } catch (e) {
      const msg = msgs.sqlExecFailed(
        e instanceof Error ? e.message : String(e),
      );
      await this.triggerLogError(sqlLogId, sqlOperate);
      yield* this.fail(record.id, msg);
      return;
    }
    await this.prisma.chatRecord.update({
      where: { id: record.id },
      data: {
        sqlExecResult: queryResult as unknown as Prisma.InputJsonValue,
        data: queryResult as unknown as Prisma.InputJsonValue,
      },
    });
    // No inline columns/rows — frontend GETs
    // /chat/record/:rid/data on receipt of this signal.
    yield { type: 'sql-data', data: { content: 'execute-success' } };

    // --- generate chart ------------------------------------------------
    yield { type: 'info', data: { msg: msgs.generateChart } };
    // Same task-start snapshot `cfg` as the SQL step — the chart context's
    // terminology/data-training retrieval must not re-resolve mid-task.
    const chartCtx = await this.aiQuestionService.buildForResult({
      question: content,
      datasourceId,
      engine,
      sql,
      sqlResult: JSON.stringify(queryResult),
      history,
      tableIds,
      embeddingConfig: cfg,
      lang,
      semantics: semanticAnnotations,
      metrics: metricText,
      namingRules: namingText,
    });
    let chartResult: ChartGenResult | null = null;
    const chartLogId = await this.startLog(record.id, 'GENERATE_CHART');
    let chartReasoning = '';
    // Capture the chart messages snapshot + content + usage.
    let chartMessages: SerializedMessage[] | undefined;
    let chartContent = '';
    let chartTokenUsage: TokenUsage | undefined;
    try {
      for await (const ev of this.generatorService.generateChart(
        chartCtx,
        modelId,
      )) {
        if (ev.type === 'messages') {
          chartMessages = ev.messages;
        } else if (ev.type === 'reasoning') {
          chartReasoning += ev.delta;
          yield {
            type: 'chart-result',
            data: { reasoning_content: ev.delta },
          };
        } else if (ev.type === 'content') {
          chartContent += ev.delta;
          yield { type: 'chart-result', data: { content: ev.delta } };
        } else if (ev.type === 'usage') {
          chartTokenUsage = ev.usage;
        } else if (ev.type === 'result') {
          chartResult = (ev.data as ChartGenResult | null) ?? null;
        }
      }
      await this.endLog(chartLogId, {
        reasoning: chartReasoning,
        messages: this.appendAiMessage(chartMessages, chartContent),
        tokenUsage: chartTokenUsage,
      });
    } catch (e) {
      await this.triggerLogError(chartLogId);
      throw e;
    }
    if (chartResult) {
      // Persist + stream the chart-object shape the Vue frontend
      // renders (type/axis/columns). The raw field-mapping config is kept in
      // chartAnswer for audit.
      const chartObject = buildQueryPrismChartObject(
        chartResult.chartType,
        chartResult.config,
        queryResult.columns,
      );
      await this.prisma.chatRecord.update({
        where: { id: record.id },
        data: {
          chart: chartObject as unknown as Prisma.InputJsonValue,
          chartType: chartResult.chartType,
          chartAnswer: JSON.stringify(chartResult.config),
        },
      });
      // chart config is a JSON string the frontend JSONBig.parse-es.
      yield {
        type: 'chart',
        data: { content: JSON.stringify(chartObject) },
      };
    }

    // --- finish --------------------------------------------------------
    // endLog on the success path — writes accumulated reasoning +
    // the (possibly filter-overridden) operate + the post-stream messages
    // (pre-stream + appended AI message) + tokenUsage.
    await this.endLog(sqlLogId, {
      reasoning: sqlReasoning,
      operate: sqlOperate,
      messages: this.appendAiMessage(sqlMessages, sqlContent),
      tokenUsage: sqlTokenUsage,
    });
    await this.finishRecord(record.id, null);
    // Audit never blocks the response — swallow its own failures.
    this.audit
      .record({
        module: OperationModule.CHAT,
        type: OperationType.CREATE,
        status: 'success',
        detail: content.slice(0, 200),
        resources: [{ name: 'chat', originId: chatId }],
      })
      .catch((e) =>
        this.logger.warn(
          `audit failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    // Fire-and-forget: seed recommended questions on a chat's first success
    // (idempotent — re-checks chat.recommendedQuestion inside). Never blocks.
    void this.generateAndCacheGuessQuestions(chatId, lang).catch((e) =>
      this.logger.warn(
        `guess failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    yield { type: 'finish', data: {} };
  }

  /** Yield the error + finish pair for a mid-pipeline failure and mark the
   *  record done. Delegated via `yield*` so callers stay linear. */
  private async *fail(
    recordId: number,
    message: string,
  ): AsyncGenerator<ChatSseEvent> {
    yield { type: 'error', data: { content: message } };
    await this.finishRecord(recordId, message);
    yield { type: 'finish', data: {} };
  }

  /** Attach the actor-effective table meaning to clarify candidates. Reuses
   *  the rule-2 annotation load when it covered every option name; otherwise
   *  resolves the whole option set once (pauses are rare). Missing semantics
   *  simply leave `meaning` off — the UI falls back to `comment`. */
  private async clarifyOptionsWithMeanings(
    datasourceId: number,
    options: ClarifyOption[],
    cfg: EmbeddingConfig,
    existing?: SemanticAnnotations,
    annotatedNames?: string[],
  ): Promise<ClarifyOption[]> {
    if (!cfg.semanticEnabled || options.length === 0) return options;
    const names = options.map((o) => o.tableName);
    const loaded = new Set(annotatedNames ?? []);
    const annotations =
      existing && names.every((n) => loaded.has(n))
        ? existing
        : await this.semanticService.effectiveAnnotations(datasourceId, names);
    return options.map((o) => {
      const meaning = annotations.tableMeanings[o.tableName];
      return meaning ? { ...o, meaning } : o;
    });
  }

  /** Render the `{candidate_tables}` prompt block: recalled tables omitted
   *  from the stuffed schema, one `- name: meaning|comment` line each. */
  private renderCandidateTables(
    options: ClarifyOption[],
    stuffedIds: Set<number>,
  ): string {
    return options
      .filter((o) => !stuffedIds.has(o.id))
      .map((o) => {
        const desc = (o.meaning ?? '').trim() || (o.comment ?? '').trim();
        return desc ? `- ${o.tableName}: ${desc}` : `- ${o.tableName}`;
      })
      .join('\n');
  }

  /** Persist the pending-clarify state + emit the clarify frame and the
   *  terminal finish (the record stays finish:false + clarifyStatus:'pending'
   *  until the user answers via /chat/record/:rid/clarify). `reason` carries
   *  the LLM's one-liner when the pause comes from the need_clarify contract
   *  (rule 2) rather than the deterministic gate (rule 1). `suggestedTableIds`
   *  is advisory preselection (current schema + LLM-named tables, capped at
   *  maxSelect); the resume endpoint still enforces the cap. */
  private async *pauseForClarify(
    recordId: number,
    question: string,
    pool: ClarifyOption[],
    maxSelect: number,
    reason?: string,
    suggestedTableIds?: number[],
  ): AsyncGenerator<ChatSseEvent> {
    const payload = {
      question,
      candidates: pool.map((c) => ({
        table_id: c.id,
        table_name: c.tableName,
        comment: c.comment,
        ...(c.meaning ? { meaning: c.meaning } : {}),
      })),
      max_select: maxSelect,
      ...(reason ? { reason } : {}),
      ...(suggestedTableIds && suggestedTableIds.length > 0
        ? { suggested_table_ids: suggestedTableIds }
        : {}),
    };
    await this.prisma.chatRecord.update({
      where: { id: recordId },
      data: {
        clarify: payload,
        clarifyStatus: 'pending',
      },
    });
    yield { type: 'clarify', data: { record_id: recordId, ...payload } };
    yield { type: 'finish', data: {} };
  }

  // --- oid-scoped CRUD ---------------------------------------------------

  async start(
    opts: {
      datasourceId?: number;
      title?: string;
      origin?: number;
    } = {},
  ): Promise<StartedChat> {
    const oid = this.currentOid();
    // A chat may only bind a datasource owned by the current workspace.
    // findOne is workspace-scoped and throws 404 for a foreign/missing id.
    const ds =
      opts.datasourceId != null
        ? await this.datasourceService.findOne(opts.datasourceId)
        : null;
    const title = opts.title || tr('chat.default_title');

    // Chat + placeholder record are one unit of work: the frontend keys the
    // input area on `computedMessages.length`, and create_chat always
    // seeds a datasource-backed chat with a finished first_chat record. Without
    // it a fresh chat renders the welcome screen with no text box at all.
    const { chat, record } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chat.create({
        data: {
          oid,
          createBy: this.currentUid(),
          datasourceId: ds?.id ?? null,
          // engine_type is cached at creation.
          engineType: ds ? engineFromDatasourceType(ds.type) : null,
          title,
          brief: title,
          origin: opts.origin ?? 0,
        },
      });
      let firstRecord: ChatRecord | null = null;
      if (ds) {
        firstRecord = await tx.chatRecord.create({
          data: {
            chatId: created.id,
            oid,
            createBy: this.currentUid(),
            question: '',
            firstChat: true,
            finish: true,
          },
        });
      }
      return { chat: created, record: firstRecord };
    });
    await this.maintainChatLimit(oid);
    return Object.assign(chat, {
      records: record ? [record] : [],
      datasource: ds,
    });
  }

  async findAll(limit?: number): Promise<Chat[]> {
    const oid = this.currentOid();
    const take = limit ?? this.config.get<number>('chat.chatLimit') ?? 20;
    // e58d1822: order by the NEWEST record's create_time (coalesce → the
    // chat's own create_time when it has no records) instead of updatedAt
    // (which only moves on explicit chat.update). maintainChatLimit caps the
    // per-workspace chat count, so fetch-all + JS sort is bounded work.
    const chats = await this.prisma.chat.findMany({
      where: {
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      include: {
        datasource: true,
        records: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    return chats
      .sort(
        (a, b) =>
          (b.records?.[0]?.createdAt ?? b.createdAt).getTime() -
          (a.records?.[0]?.createdAt ?? a.createdAt).getTime(),
      )
      .slice(0, take);
  }

  async findOne(id: number): Promise<Chat> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(id, oid),
      include: {
        datasource: { include: { tables: { include: { fields: true } } } },
        records: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!chat) throw new NotFoundException(tr('chat.chat_not_found', { id }));
    return chat;
  }

  /** Like findOne but also loads each record's ChatLog rows (the Phase 5b
   *  execution-details view needs them). */
  async getWithData(id: number): Promise<Chat> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(id, oid),
      include: {
        datasource: { include: { tables: { include: { fields: true } } } },
        // Exclude the background GENERATE_RECOMMENDED_QUESTIONS log
        // from the chat-detail view (parity with the 3 dedicated loaders;
        // it is excluded from every history reader).
        records: {
          orderBy: { createdAt: 'asc' },
          include: {
            logs: {
              where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
            },
          },
        },
      },
    });
    if (!chat) throw new NotFoundException(tr('chat.chat_not_found', { id }));
    return chat;
  }

  async rename(id: number, title: string): Promise<Chat> {
    const oid = this.currentOid();
    const existing = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(id, oid),
    });
    if (!existing)
      throw new NotFoundException(tr('chat.chat_not_found', { id }));
    return this.prisma.chat.update({ where: { id }, data: { title } });
  }

  /** Contract rename: the frontend renames `brief`
   *  (the exposed display field), so this updates BOTH `brief` + the internal
   *  `title` to keep them in sync. Distinct from `rename` (which the Phase 5b
   *  spec pins to `data: { title }` exactly) so that contract stays green. */
  async renameBrief(id: number, brief: string): Promise<Chat> {
    const oid = this.currentOid();
    const existing = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(id, oid),
    });
    if (!existing)
      throw new NotFoundException(tr('chat.chat_not_found', { id }));
    return this.prisma.chat.update({
      where: { id },
      data: { title: brief, brief },
    });
  }

  async remove(id: number): Promise<{ success: true }> {
    const oid = this.currentOid();
    const existing = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(id, oid),
    });
    if (!existing)
      throw new NotFoundException(tr('chat.chat_not_found', { id }));
    await this.prisma.chat.delete({ where: { id } });
    return { success: true };
  }

  // --- Phase 5b: secondary reads (record data / logs / usage / recommend) --

  /** Persisted query result for a record (read from disk, no re-execution).
   *  Returns the wire shape `{fields, fields_info, data}`. `fields_info` is null:
   *  MCB's db-connector QueryResult lacks per-column type info, and the chart
   *  renderer (ChartBlock.vue:393) guards `if (fields_info)` and falls back to
   *  axis-based numeric inference when absent. */
  async getRecordData(
    chatId: number,
    rid: number,
  ): Promise<QueryPrismDataShape> {
    const record = await this.requireRecord(chatId, rid);
    const qr = (record.sqlExecResult as QueryResult | null) ?? {
      columns: [],
      rows: [],
    };
    return toQueryPrismDataShape(qr);
  }

  /** Re-run the record's SQL against the live DB (fresh rows), returning the
   *  same wire shape (no `sql` field, unlike exec_sql). The stored SQL was
   *  safety-validated at first run; re-running
   *  it is acceptable. */
  async getRecordDataLive(
    chatId: number,
    rid: number,
  ): Promise<QueryPrismDataShape> {
    const record = await this.requireRecord(chatId, rid);
    if (!record.sql) {
      throw new BadRequestException(tr('chat.record_no_sql'));
    }
    const chat = await this.requireChat(chatId);
    if (chat.datasourceId == null) {
      throw new BadRequestException(tr('chat.chat_no_datasource'));
    }
    const qr = await this.datasourceService.execSql(
      chat.datasourceId,
      record.sql,
    );
    return toQueryPrismDataShape(qr);
  }

  /** Combined record snapshot for the MCP non-streaming path. The
   *  9c SSE contract no longer inlines query rows or chartType in the stream
   *  (sql-data carries only `{content:'execute-success'}`; chart carries only
   *  the JSON-stringified config), so mcp_question drains the stream for
   *  sql/brief/chart_config/error then fetches rows + chartType here in a
   *  single read. */
  async getRecordChartData(
    chatId: number,
    rid: number,
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    chartType: string | null;
  }> {
    const record = await this.requireRecord(chatId, rid);
    const qr = (record.sqlExecResult as QueryResult | null) ?? {
      columns: [],
      rows: [],
    };
    return {
      columns: qr.columns,
      rows: qr.rows,
      truncated: qr.rows.length >= this.limitRows(),
      chartType: record.chartType,
    };
  }

  /** Persisted predict_data payload for a record (the chart's forecast series),
   *  coerced to the list-of-objects shape. Returns [] when
   *  the stored value is null/unknown so the predict table renders an empty
   *  state instead of crashing on `.map`. */
  async getPredictData(
    chatId: number,
    rid: number,
  ): Promise<Record<string, unknown>[]> {
    const record = await this.requireRecord(chatId, rid);
    return toQueryPrismListShape(record.predictData);
  }

  /** Per-LLM-call logs for a record (the execution-details viewer). */
  async getRecordLogs(
    chatId: number,
    rid: number,
  ): Promise<
    Array<{
      id: number;
      messages: unknown;
      reasoningContent: string | null;
      tokenUsage: unknown;
      startedAt: Date;
      endedAt: Date | null;
    }>
  > {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        chatId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      // Exclude the background GENERATE_RECOMMENDED_QUESTIONS log from
      // the user-visible step list.
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    if (!record)
      throw new NotFoundException(tr('chat.record_not_found', { id: rid }));
    return record.logs.map((l) => ({
      id: l.id,
      messages: l.messages,
      reasoningContent: l.reasoningContent,
      tokenUsage: l.tokenUsage,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
    }));
  }

  /** Aggregated token usage across all LLM calls for a record, in the
   *  ChatLogHistory shape with `steps: []`
   *  (served by `/record/:rid/usage`). The aggregates (start_time/finish_time/
   *  duration/total_tokens) are built by toChatLogHistorySnake; the
   *  GENERATE_RECOMMENDED_QUESTIONS background log is excluded (a
   *  fire-and-forget cache-warmer, not user-billed). */
  async getRecordUsage(
    chatId: number,
    rid: number,
  ): Promise<ChatLogHistorySnake> {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        chatId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      // Exclude the background GENERATE_RECOMMENDED_QUESTIONS log
      // from the token sum (recommend-questions
      // is a fire-and-forget cache-warmer, not a user-billed step).
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    if (!record)
      throw new NotFoundException(tr('chat.record_not_found', { id: rid }));
    return toChatLogHistorySnake(record, record.logs, {
      withoutSteps: true,
    });
  }

  /** Resolve the chat id for a record (oid-scoped). The frontend's
   *  record routes (`/chat/record/:rid/...`) are rid-only — no chat_id in the
   *  path — so the controller asks the service to resolve it. 404 if the
   *  record is missing or out of workspace scope. */
  async findChatIdByRecord(rid: number): Promise<number> {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      select: { chatId: true },
    });
    if (!record)
      throw new NotFoundException(tr('chat.record_not_found', { id: rid }));
    return record.chatId;
  }

  /** Aggregated log history for a record (rid-only). Loads the record + its
   *  logs, maps to the ChatLogHistory shape (start/finish/duration/
   *  total_tokens aggregated + steps[] per LLM call) via toChatLogHistorySnake. */
  async getRecordLogHistory(rid: number): Promise<ChatLogHistorySnake> {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      // Exclude the background GENERATE_RECOMMENDED_QUESTIONS log from
      // the history view + token sum.
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
    if (!record)
      throw new NotFoundException(tr('chat.record_not_found', { id: rid }));
    return toChatLogHistorySnake(record, record.logs);
  }

  // --- rid-only SSE wrappers ------------------------------------------------
  // The contract routes `/chat/record/:rid/analysis|predict` are
  // rid-only. These wrappers resolve chatId from rid (404 throws on the
  // first .next(), before the stream commits headers → plain-string error),
  // then delegate to the chatId-based generators (unchanged, spec-covered).

  async *runAnalysisByRid(
    rid: number,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const chatId = await this.findChatIdByRecord(rid);
    yield* this.runAnalysis(chatId, rid, modelId);
  }

  async *runPredictByRid(
    rid: number,
    modelId?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const chatId = await this.findChatIdByRecord(rid);
    yield* this.runPredict(chatId, rid, modelId);
  }

  /** Stream recommended questions for a record (rid-only). LIVE LLM
   *  reasoning stream.
   *  Forward reasoning/content deltas as `recommended_question_result`,
   *  capture the parsed GuessResult, persist Chat.recommendedQuestion, emit
   *  one terminal `recommended_question` (content = JSON.stringify(string[])
   *  — frontend validates starts `[` ends `]`), then `finish`.
   *  `articles_number` bounds the count (template {articles_number} + post-gen
   *  truncation safety net; default 4). Record-not-found → empty
   *  terminal frame (NOT a 404). LLM exception → `error` +
   *  `finish` (no terminal). The frontend currently DROPS
   *  `recommended_question_result` deltas (no switch arm) — emitting them is
   *  for future progressive-UI; only the terminal
   *  `recommended_question` is rendered. */
  async *runRecommendQuestions(
    rid: number,
    articlesNumber?: number,
  ): AsyncGenerator<ChatSseEvent> {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      select: { chatId: true, question: true },
    });
    if (!record) {
      // record-not-found → single empty terminal frame (no 404).
      yield { type: 'recommended_question', data: { content: '[]' } };
      yield { type: 'finish', data: {} };
      return;
    }
    try {
      const chat = await this.prisma.chat.findFirst({
        where: this.ownedChatWhere(record.chatId, oid),
      });
      if (!chat || chat.datasourceId == null) {
        // No datasource → can't build the guess context (an edge case;
        // chats are normally bound to a datasource). Emit empty terminal.
        yield { type: 'recommended_question', data: { content: '[]' } };
        yield { type: 'finish', data: {} };
        return;
      }
      const ds = await this.datasourceService.findOne(chat.datasourceId);
      const engine = engineFromDatasourceType(ds.type);
      if (!engine) {
        yield { type: 'recommended_question', data: { content: '[]' } };
        yield { type: 'finish', data: {} };
        return;
      }
      const cfg = await resolveEmbeddingConfig(this.prisma);
      const tableIds = await this.recallNarrowedSchema(
        chat.datasourceId,
        record.question,
        { config: cfg },
      );
      const history = await this.getHistory(
        record.chatId,
        this.historyRounds(),
      );
      const ctx = await this.aiQuestionService.buildSqlContext({
        question: record.question,
        datasourceId: chat.datasourceId,
        engine,
        history,
        tableIds,
        embeddingConfig: cfg,
        // The recommended questions follow the record question's language.
        lang: this.detectLang(record.question),
      });
      ctx.articlesNumber = articlesNumber;
      // Lifecycle for the recommend-questions LLM call (11C's
      // startLog/endLog/triggerLogError triplet). The operate tag is
      // GENERATE_RECOMMENDED_QUESTIONS (='4'). On failure, triggerLogError
      // fires on catch (the 11C pattern) — marks the log errored at once
      // instead of leaving it dangling.
      const recQLogId = await this.startLog(
        rid,
        'GENERATE_RECOMMENDED_QUESTIONS',
      );
      let guess: GuessResult | null = null;
      // Capture the pre-stream messages snapshot + streamed
      // content + final-chunk usage for endLog.
      let preStream: SerializedMessage[] | undefined;
      let content = '';
      let reasoning = '';
      let tokenUsage: TokenUsage | undefined;
      try {
        for await (const ev of this.generatorService.generateGuessQuestion(
          ctx,
          undefined,
        )) {
          if (ev.type === 'messages') {
            preStream = ev.messages;
          } else if (ev.type === 'reasoning') {
            reasoning += ev.delta;
            yield {
              type: 'recommended_question_result',
              data: { reasoning_content: ev.delta },
            };
          } else if (ev.type === 'content') {
            content += ev.delta;
            yield {
              type: 'recommended_question_result',
              data: { content: ev.delta },
            };
          } else if (ev.type === 'usage') {
            tokenUsage = ev.usage;
          } else if (ev.type === 'result') {
            guess = (ev.data as GuessResult | null) ?? null;
          }
        }
        await this.endLog(recQLogId, {
          reasoning,
          messages: this.appendAiMessage(preStream, content),
          tokenUsage,
        });
      } catch (e) {
        await this.triggerLogError(recQLogId);
        throw e;
      }
      const all = guess?.questions ?? [];
      // Truncate to articles_number (safety net — LLMs aren't reliably
      // count-accurate; the template's {articles_number} is the primary bound).
      const cap = articlesNumber ?? 4;
      const questions = all.slice(0, cap);
      if (questions.length > 0) {
        await this.prisma.chat.update({
          where: { id: record.chatId },
          data: { recommendedQuestion: questions },
        });
      }
      yield {
        type: 'recommended_question',
        data: { content: JSON.stringify(questions) },
      };
      yield { type: 'finish', data: {} };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `recommend_questions failed for record #${rid}: ${msg}`,
      );
      yield { type: 'error', data: { content: msg } };
      yield { type: 'finish', data: {} };
    }
  }

  /** Recent distinct questions across the workspace, optionally filtered to
   *  a datasource (route `/chat/recent_questions/:dsid`). When
   *  `dsid` is omitted the call reverts to the workspace-wide behavior
   *  (preserves the Phase 5b unit-contract — the spec calls it with no args). */
  async getRecentQuestions(dsid?: number): Promise<{ questions: string[] }> {
    const oid = this.currentOid();
    const where = {
      oid,
      OR: [{ createBy: this.currentUid() }, { createBy: null }],
      ...(dsid != null ? { chat: { datasourceId: dsid } } : {}),
    };
    const rows = await this.prisma.chatRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { question: true },
    });
    const seen = new Set<string>();
    const questions: string[] = [];
    for (const r of rows) {
      if (!r.question || seen.has(r.question)) continue;
      seen.add(r.question);
      questions.push(r.question);
      if (questions.length >= 20) break;
    }
    return { questions };
  }

  /** Recommended questions for a chat: the cached LLM guess (generated
   *  fire-and-forget on the first successful question) + the datasource's
   *  seeded DsRecommendedProblem rows. Pure cache read — never calls the LLM. */
  async getRecommendQuestions(chatId: number): Promise<{
    questions: string[];
    recommended: Array<{ id: number; question: string }>;
  }> {
    const chat = await this.requireChat(chatId);
    const questions = (chat.recommendedQuestion as string[] | null) ?? [];
    let recommended: Array<{ id: number; question: string }> = [];
    if (chat.datasourceId != null) {
      recommended = await this.prisma.dsRecommendedProblem.findMany({
        where: { datasourceId: chat.datasourceId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, question: true },
      });
    }
    return { questions, recommended };
  }

  /** Export a record's query result to an .xlsx buffer. `rid` picks a specific
   *  record; omitted → the chat's latest record. Mirrors
   *  DataTrainingService.exportExcel (export-only needs no LoadParam cast). */
  async exportRecordExcel(chatId: number, rid?: number): Promise<Buffer> {
    const oid = this.currentOid();
    const record =
      rid != null
        ? await this.prisma.chatRecord.findFirst({
            where: {
              id: rid,
              chatId,
              oid,
              OR: [{ createBy: this.currentUid() }, { createBy: null }],
            },
          })
        : await this.prisma.chatRecord.findFirst({
            where: {
              chatId,
              oid,
              OR: [{ createBy: this.currentUid() }, { createBy: null }],
            },
            orderBy: { createdAt: 'desc' },
          });
    if (!record) throw new NotFoundException(tr('chat.record_not_found_plain'));
    const qr = record.sqlExecResult as QueryResult | null;
    if (!qr) throw new BadRequestException(tr('chat.record_no_export_data'));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.columns = qr.columns.map((c) => ({
      header: c,
      key: c,
      width: 20,
    }));
    for (const row of qr.rows) {
      ws.addRow(row);
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** Fire-and-forget: on a chat's first successful question, drain
   *  generateGuessQuestion and cache the result on Chat.recommendedQuestion.
   *  Idempotent (re-checks the cache), never throws — LLM unavailable just
   *  logs + skips, leaving the GET to return only seeded questions. */
  private async generateAndCacheGuessQuestions(
    chatId: number,
    lang: string,
  ): Promise<void> {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    if (
      !chat ||
      chat.recommendedQuestion != null ||
      chat.datasourceId == null
    ) {
      return;
    }
    const ds = await this.datasourceService.findOne(chat.datasourceId);
    const engine = engineFromDatasourceType(ds.type);
    if (!engine) return;
    const last = await this.prisma.chatRecord.findFirst({
      where: {
        chatId,
        finish: true,
        error: null,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      orderBy: { createdAt: 'desc' },
      select: { question: true },
    });
    const question = last?.question ?? '';
    const cfg = await resolveEmbeddingConfig(this.prisma);
    const tableIds = await this.recallNarrowedSchema(
      chat.datasourceId,
      question,
      {
        config: cfg,
      },
    );
    const history = await this.getHistory(chatId, this.historyRounds());
    const ctx = await this.aiQuestionService.buildSqlContext({
      question,
      datasourceId: chat.datasourceId,
      engine,
      history,
      tableIds,
      embeddingConfig: cfg,
      // The recommended questions follow the triggering turn's language.
      lang,
    });
    let guess: GuessResult | null = null;
    for await (const ev of this.generatorService.generateGuessQuestion(
      ctx,
      undefined,
    )) {
      if (ev.type === 'result') {
        guess = (ev.data as GuessResult | null) ?? null;
      }
    }
    if (guess && guess.questions.length > 0) {
      await this.prisma.chat.update({
        where: { id: chatId },
        data: {
          recommendedQuestion: guess.questions,
        },
      });
    }
  }

  /** Load a ChatRecord oid-scoped within a chat, 404 if missing/wrong scope. */
  private async requireRecord(chatId: number, rid: number) {
    const oid = this.currentOid();
    const record = await this.prisma.chatRecord.findFirst({
      where: {
        id: rid,
        chatId,
        oid,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
    });
    if (!record)
      throw new NotFoundException(tr('chat.record_not_found', { id: rid }));
    return record;
  }

  /** Load a chat oid/user-scoped, 404 if missing/wrong scope. */
  private async requireChat(chatId: number) {
    const oid = this.currentOid();
    const chat = await this.prisma.chat.findFirst({
      where: this.ownedChatWhere(chatId, oid),
    });
    if (!chat)
      throw new NotFoundException(tr('chat.chat_not_found', { id: chatId }));
    return chat;
  }

  // --- helpers -----------------------------------------------------------

  /** The user's profile language — the fallback for turns whose question is
   *  in a script we don't recognize (ja/ko/…) and for pre-question errors
   *  (quick-command usage, chat/record 404s in the secondary flows). */
  private profileLang(): string {
    return RequestContext.getUser()?.language ?? 'en';
  }

  /** Reply language for a turn: the question's own language (Chinese →
   *  zh-CN, Latin → en), falling back to the profile language. */
  private detectLang(question: string): string {
    return detectQuestionLanguage(question, this.profileLang());
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  /** Creator uid of the current request (Chat.create_by scoping). */
  private currentUid(): number {
    const uid = RequestContext.getUser()?.id;
    if (uid === undefined) {
      throw new UnauthorizedException(tr('common.user_unresolved'));
    }
    return uid;
  }

  /** Chat lookup scoped to the workspace AND the current user. Legacy rows
   *  (createBy null) stay visible to the whole workspace. */
  private ownedChatWhere(id: number, oid: number): Prisma.ChatWhereInput {
    return {
      id,
      oid,
      OR: [{ createBy: this.currentUid() }, { createBy: null }],
    };
  }

  /** Record lookup scoped to the owning chat + the current user (legacy null
   *  rows remain visible within the workspace). */
  private ownedRecordWhere(
    id: number,
    oid: number,
  ): Prisma.ChatRecordWhereInput {
    return {
      id,
      oid,
      OR: [{ createBy: this.currentUid() }, { createBy: null }],
    };
  }

  /** recallTables → tableIds (undefined when recall is empty so getMSchema
   *  falls back to all checked tables). `opts.keywords` is the terminology-
   *  expanded keyword string for the fusion ranking; `opts.config` is the
   *  task-start snapshot (resolved here when not supplied). */
  private async recallNarrowedSchema(
    datasourceId: number,
    question: string,
    opts?: { keywords?: string | null; config?: EmbeddingConfig },
  ): Promise<number[] | undefined> {
    const config = opts?.config ?? (await resolveEmbeddingConfig(this.prisma));
    const tables = await this.datasourceService.recallTables(
      datasourceId,
      question,
      { keywords: opts?.keywords ?? null, config },
    );
    return tables.length > 0 ? tables.map((t) => t.id) : undefined;
  }

  /** One LLM call pulls the core
   *  business entities out of the question, with prior USER questions as
   *  context (AI replies excluded — only prior user questions are used).
   *  Logged as an EXTRACT_KEYWORDS ChatLog row. Returns the comma-separated
   *  keywords, or null on failure / EMPTY / ERROR:NOT_DATA_QUERY — the
   *  sentinels do NOT reject the turn (MCB keeps answering, recall just
   *  uses the raw question). */
  private async extractKeywords(
    recordId: number,
    chatId: number,
    question: string,
    engine: EngineType,
    lang: string,
    modelId?: number,
  ): Promise<string | null> {
    const logId = await this.startLog(recordId, 'EXTRACT_KEYWORDS');
    try {
      const userHistory = (
        await this.getHistory(chatId, this.historyRounds())
      ).filter((h) => h.role === 'user');
      const ctx = this.aiQuestionService.buildForKeywords({
        question,
        engine,
        history: userHistory,
        lang,
      });
      let text = '';
      let reasoning = '';
      let messages: SerializedMessage[] | undefined;
      let tokenUsage: TokenUsage | undefined;
      for await (const ev of this.generatorService.extractKeywords(
        ctx,
        modelId,
      )) {
        if (ev.type === 'messages') messages = ev.messages;
        else if (ev.type === 'reasoning') reasoning += ev.delta;
        else if (ev.type === 'content') text += ev.delta;
        else if (ev.type === 'usage') tokenUsage = ev.usage;
      }
      const answer = text.trim();
      await this.endLog(logId, {
        reasoning,
        messages,
        tokenUsage,
      });
      if (
        !answer ||
        answer === 'EMPTY' ||
        answer.startsWith('ERROR:NOT_DATA_QUERY')
      ) {
        return null;
      }
      return answer;
    } catch (e) {
      this.logger.warn(
        `keyword extraction failed, recalling with the raw question: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.triggerLogError(logId);
      return null;
    }
  }

  /** Last N finished + error-free ChatRecords as chronological Q/A rounds for
   *  the prompt's history placeholder. The in-progress record (finish=false)
   *  is excluded by the filter, so it never leaks into its own history. */
  private async getHistory(
    chatId: number,
    rounds: number,
  ): Promise<ChatHistoryRound[]> {
    const records = await this.prisma.chatRecord.findMany({
      where: {
        chatId,
        // The placeholder seeded by start() is not a Q/A round.
        firstChat: false,
        finish: true,
        error: null,
        OR: [{ createBy: this.currentUid() }, { createBy: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: rounds,
    });
    const ordered = [...records].reverse();
    const out: ChatHistoryRound[] = [];
    for (const r of ordered) {
      out.push({ role: 'user', content: this.userRoundContent(r) });
      const answer = r.sqlAnswer ?? r.brief ?? r.sql ?? '';
      if (answer) out.push({ role: 'assistant', content: answer });
    }
    return out;
  }

  /** The user turn = the original question + the clarify round's answer
   *  (picked table names / supplement text), so later turns inherit the
   *  clarification instead of re-asking. The label is prompt-side content —
   *  zh-CN only is acceptable (the LLM reads both, the user never sees it). */
  private userRoundContent(r: {
    question: string;
    clarifyAnswer: Prisma.JsonValue | null;
  }): string {
    const a = r.clarifyAnswer;
    if (a == null || typeof a !== 'object' || Array.isArray(a)) {
      return r.question;
    }
    const extras: string[] = [];
    const tableNames = (a as { table_names?: unknown }).table_names;
    if (
      Array.isArray(tableNames) &&
      tableNames.some((n) => typeof n === 'string')
    ) {
      extras.push(
        `涉及表：${tableNames.filter((n): n is string => typeof n === 'string').join('、')}`,
      );
    }
    const text = (a as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) extras.push(text.trim());
    return extras.length ? `${r.question}（${extras.join('；')}）` : r.question;
  }

  /** INSERT a ChatLog row at the start of an LLM step — the row
   *  exists immediately so a mid-stream crash still leaves an audit trail
   *  (the gap closed by the start/end split; the old single-INSERT persistLog
   *  created no row if the step threw before completion). Returns the
   *  committed row id for the paired endLog/triggerLogError. `operate` is the
   *  operation NAME (frontend i18n key); `localOp` defaults false —
   *  all tagged steps are LLM calls. The pre-stream `messages` snapshot
   *  is NOT INSERT'd here (startLog runs before the stream; the messages event
   *  is the first stream event). */
  private async startLog(
    recordId: number,
    operate: string,
    localOp = false,
  ): Promise<number> {
    const row = await this.prisma.chatLog.create({
      data: {
        chatRecordId: recordId,
        operate,
        startedAt: new Date(),
        localOperation: localOp,
        error: false,
      },
    });
    return row.id;
  }

  /** UPDATE the started row at successful step completion — write the
   *  accumulated reasoning + stamp endedAt. `operate` overrides the initial
   *  tag when the step's nature changed mid-flow (filter-merge:
   *  GENERATE_SQL → GENERATE_SQL_WITH_PERMISSIONS). `messages` is
   *  the post-stream list (pre-stream + appended AI message); `tokenUsage` is
   *  the final-chunk usage snapshot. */
  private async endLog(
    id: number,
    opts: {
      reasoning: string;
      operate?: string;
      messages?: unknown;
      tokenUsage?: unknown;
    },
  ): Promise<void> {
    await this.prisma.chatLog.update({
      where: { id },
      data: {
        reasoningContent: opts.reasoning || null,
        operate: opts.operate,
        messages: opts.messages as Prisma.InputJsonValue | undefined,
        tokenUsage: opts.tokenUsage as Prisma.InputJsonValue | undefined,
        endedAt: new Date(),
      },
    });
  }

  /** Build the post-stream messages snapshot — the pre-stream list
   *  (captured from the generator's first `messages` event) + an appended AI
   *  message carrying the accumulated streamed content (the LLM's raw text
   *  response, like end_log appending the final AIMessage).
   *  Returns undefined when no pre-stream snapshot was captured (the column
   *  stays null — e.g. a generator that didn't emit a messages event). */
  private appendAiMessage(
    preStream: SerializedMessage[] | undefined,
    content: string,
  ): SerializedMessage[] | undefined {
    if (!preStream) return undefined;
    return [...preStream, { type: 'ai', queryprism_system: false, content }];
  }

  /** UPDATE the started row as failed — error=true + stamp endedAt.
   *  `operate` overrides the tag for the same filter-merge reason. */
  private async triggerLogError(id: number, operate?: string): Promise<void> {
    await this.prisma.chatLog.update({
      where: { id },
      data: {
        error: true,
        operate,
        endedAt: new Date(),
      },
    });
  }

  private async finishRecord(
    recordId: number,
    error: string | null,
  ): Promise<void> {
    // On a record-level crash (error ≠ null), bulk-mark every
    // not-yet-finished ChatLog row for this record as errored + stamp endedAt.
    // The success path (error === null) skips this — every step's endLog
    // already fired, so there are no dangling logs. The where:endedAt:null
    // filter leaves already-ended rows untouched (triggerLogError'd rows
    // already carry endedAt → excluded from the bulk-update).
    if (error !== null) {
      await this.markUnfinishedLogsErrored(recordId);
    }
    await this.prisma.chatRecord.update({
      where: { id: recordId },
      data: { finish: true, error },
    });
  }

  /** Bulk-mark every not-yet-finished ChatLog row for a record as
   *  errored + stamp endedAt. The record-level crash safety net — catches any
   *  log that started but never got an endLog/triggerLogError (e.g. a step
   *  that threw before its catch fired): rows with a null endedAt get
   *  error=true + endedAt=now in one bulk update. */
  private async markUnfinishedLogsErrored(recordId: number): Promise<void> {
    await this.prisma.chatLog.updateMany({
      where: { chatRecordId: recordId, endedAt: null },
      data: { error: true, endedAt: new Date() },
    });
  }

  private async maintainChatLimit(oid: number): Promise<void> {
    const limit = this.config.get<number>('chat.chatLimit') ?? 20;
    const uid = this.currentUid();
    // Per-user cap (Chat.create_by scoping): legacy null-owner chats are
    // excluded so this cleanup never deletes another user's conversation.
    const count = await this.prisma.chat.count({
      where: { oid, createBy: uid },
    });
    if (count <= limit) return;
    const surplus = await this.prisma.chat.findMany({
      where: { oid, createBy: uid },
      orderBy: { updatedAt: 'asc' },
      take: count - limit,
    });
    const ids = surplus.map((c) => c.id);
    if (ids.length > 0) {
      await this.prisma.chat.deleteMany({ where: { id: { in: ids } } });
    }
  }

  private limitRows(): number {
    return this.config.get<number>('chat.limitRows') ?? 500;
  }

  private historyRounds(): number {
    return this.config.get<number>('chat.historyRounds') ?? 3;
  }
}
