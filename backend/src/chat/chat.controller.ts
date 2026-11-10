// ChatController — contract surface for the chat API. CRUD routes are
// JwtAuthGuard-protected + audit-decorated; the SSE routes
// (`POST /question`, `POST /record/:rid/analysis|predict`,
// `POST /recommend_questions/:rid`) pump a ChatService async generator through
// SseWriter. A generator throw before the first event (chat/record not found)
// becomes a plain-string 4xx; a throw mid-stream becomes a final
// `error` frame. SSE routes are audited inside the service.
//
// Routes are aligned to the frontend contract.
// Record routes are rid-only (`/chat/record/:rid/...`) — the
// controller resolves chatId via ChatService.findChatIdByRecord for the
// chatId-based reads. GET responses are mapped to snake_case here
// (explicit per-service mapper, NOT a global interceptor) via
// toChatInfoSnake / toChatRecordSnake; Json blobs pass through verbatim.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Chat, ChatRecord, Datasource } from '@prisma/client';
import { ChatService } from './chat.service';
import { SseWriter } from './sse-writer';
import type { ChatSseEvent } from './chat-sse-event';
import { toChatInfoSnake, toChatRecordSnake } from './chat-snake-mapper';

// Prisma's default `Chat` type excludes relation rows, but findAll/findOne/
// getWithData `include` `datasource` + `records` — the runtime carries them,
// only the declared return type is narrow. This locally widens the view so
// the mapper can read the joined relations without `as any`.
type ChatWithRels = Chat & {
  records?: ChatRecord[];
  datasource?: Datasource | null;
};
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AssistantTokenGuard } from '../auth/assistant-token.guard';
import { Public } from '../common/decorators/public.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import {
  ClarifyAnswerDto,
  DeleteChatDto,
  QuestionDto,
  RegenerateChatDto,
  RenameChatDto,
  StartChatDto,
} from '../common/dtos';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // ---------------- chat CRUD (snake_case out) --------------------------

  @Get('list')
  async findAll() {
    const chats = (await this.chatService.findAll()) as ChatWithRels[];
    return chats.map((c) => {
      const records = (c.records ?? []).map((r) =>
        toChatRecordSnake(r, { chat: c, withData: false }),
      );
      return toChatInfoSnake(c, { datasource: c.datasource ?? null, records });
    });
  }

  // Declared BEFORE `@Get(':id')` so "list" / "recent_questions" aren't
  // captured as :id.
  @Get('recent_questions/:dsid')
  recentQuestions(@Param('dsid') dsid: string) {
    return this.chatService.getRecentQuestions(+dsid);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const chat = (await this.chatService.findOne(+id)) as ChatWithRels;
    const records = (chat.records ?? []).map((r) =>
      toChatRecordSnake(r, { chat, withData: false }),
    );
    return toChatInfoSnake(chat, {
      datasource: chat.datasource ?? null,
      records,
    });
  }

  @Get(':id/with_data')
  async getWithData(@Param('id') id: string) {
    const chat = (await this.chatService.getWithData(+id)) as ChatWithRels;
    const records = (chat.records ?? []).map((r) =>
      toChatRecordSnake(r, { chat, withData: true }),
    );
    return toChatInfoSnake(chat, {
      datasource: chat.datasource ?? null,
      records,
    });
  }

  @Post('start')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.CHAT,
    type: OperationType.CREATE,
    detail: '新建对话',
    resources: (r) => {
      const c = r as { id: number };
      return [{ name: '新对话', originId: c.id }];
    },
  })
  async start(@Body() dto: StartChatDto) {
    const chat = await this.chatService.start({
      datasourceId: dto.datasource,
      origin: dto.origin,
    });
    // The start response returns the seeded first_chat record + datasource, so
    // the frontend switches from the welcome screen straight to the input box.
    const records = chat.records.map((r) =>
      toChatRecordSnake(r, { chat, withData: false }),
    );
    return toChatInfoSnake(chat, { datasource: chat.datasource, records });
  }

  // Embedded assistant start (Phase 11F). The class-level
  // JwtAuthGuard is exempted via @Public(); the
  // method-level AssistantTokenGuard verifies the `X-QUERYPRISM-ASSISTANT-TOKEN`
  // header (Assistant/Embedded schemes), populates RequestContext.user +
  // RequestContext.assistant. chatService.start reads currentOid() from the
  // guard-populated ALS — no service signature change. origin:2 (embedded) is
  // hardcoded (the assistant route defaults origin=2).
  @Post('assistant/start')
  @HttpCode(200)
  @Public()
  @UseGuards(AssistantTokenGuard)
  @SystemLog({
    module: OperationModule.CHAT,
    type: OperationType.CREATE,
    detail: '新建助手对话',
    resources: (r) => {
      const c = r as { id: number };
      return [{ name: '助手对话', originId: c.id }];
    },
  })
  async assistantStart(@Body() dto: StartChatDto) {
    const chat = await this.chatService.start({
      datasourceId: dto.datasource,
      origin: 2,
    });
    const records = chat.records.map((r) =>
      toChatRecordSnake(r, { chat, withData: false }),
    );
    return toChatInfoSnake(chat, { datasource: chat.datasource, records });
  }

  @Post('rename')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.CHAT,
    type: OperationType.UPDATE,
    detail: '重命名对话',
    resources: (r) => {
      const c = r as { id: number; brief: string };
      return [{ name: c.brief, originId: c.id }];
    },
  })
  async rename(@Body() dto: RenameChatDto) {
    await this.chatService.renameBrief(dto.id, dto.brief);
    return dto.brief; // The frontend expects the new brief string back.
  }

  @Delete(':id')
  @SystemLog({
    module: OperationModule.CHAT,
    type: OperationType.DELETE,
    detail: '删除对话',
  })
  async remove(@Param('id') id: string, @Body() dto: DeleteChatDto) {
    // The client sends {id, brief?} in the body; the body id mirrors the path.
    // Delete by the body id (authoritative) — also satisfies the DTO read.
    await this.chatService.remove(dto.id ?? +id);
    return 'success';
  }

  // ---------------- SSE streaming routes --------------------------------

  @Post('question')
  async question(
    @Body() dto: QuestionDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(
      res,
      this.chatService.runPipeline(dto.chat_id, dto.question, dto.model_id),
    );
  }

  @Post('recommend_questions/:rid')
  async recommendQuestions(
    @Param('rid') rid: string,
    @Query('articles_number') articlesNumber: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // `?articles_number=N` rides the URL (frontend sends ?articles_number=10).
    // Default 4; coerce to a non-negative integer (bad/missing → 4).
    const n = Number(articlesNumber);
    const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
    await this.stream(res, this.chatService.runRecommendQuestions(+rid, cap));
  }

  @Post('record/:rid/analysis')
  async analysis(
    @Param('rid') rid: string,
    @Body() dto: RegenerateChatDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(
      res,
      this.chatService.runAnalysisByRid(+rid, dto.model_id),
    );
  }

  @Post('record/:rid/predict')
  async predict(
    @Param('rid') rid: string,
    @Body() dto: RegenerateChatDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(
      res,
      this.chatService.runPredictByRid(+rid, dto.model_id),
    );
  }

  // Clarify answer (MetaDataImprove M1 rule 1): resumes a clarify-paused
  // record — same rid, same SSE contract as /chat/question (id → sql-result →
  // … → finish). Pre-stream 4xx (not pending / empty answer) is plain text.
  @Post('record/:rid/clarify')
  async clarify(
    @Param('rid') rid: string,
    @Body() dto: ClarifyAnswerDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(
      res,
      this.chatService.resumeClarified(
        +rid,
        {
          tableIds: dto.table_ids,
          text: dto.text,
          skip: dto.skip,
          round: dto.round,
        },
        dto.model_id,
      ),
    );
  }

  // ---------------- record reads (rid-only) -----------------------------

  @Get('record/:rid/data')
  async recordData(@Param('rid') rid: string) {
    const chatId = await this.chatService.findChatIdByRecord(+rid);
    return this.chatService.getRecordData(chatId, +rid);
  }

  @Get('record/:rid/predict_data')
  async predictData(@Param('rid') rid: string) {
    const chatId = await this.chatService.findChatIdByRecord(+rid);
    return this.chatService.getPredictData(chatId, +rid);
  }

  @Get('record/:rid/log')
  recordLogs(@Param('rid') rid: string) {
    return this.chatService.getRecordLogHistory(+rid);
  }

  @Get('record/:rid/usage')
  async recordUsage(@Param('rid') rid: string) {
    const chatId = await this.chatService.findChatIdByRecord(+rid);
    return this.chatService.getRecordUsage(chatId, +rid);
  }

  @Get('record/:rid/excel/export/:cid')
  @SystemLog({
    module: OperationModule.CHAT,
    type: OperationType.EXPORT,
    detail: '导出对话数据',
  })
  async exportRecord(
    @Param('rid') rid: string,
    @Param('cid') cid: string,
    @Res() res: Response,
  ): Promise<void> {
    const buf = await this.chatService.exportRecordExcel(+cid, +rid);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="chat-${cid}-record-${rid}.xlsx"`,
    });
    res.send(buf);
  }

  /** Drain a ChatSseEvent generator into the SSE response. The first event is
   *  pulled before committing to `text/event-stream` headers so a throw
   *  (chat/record not found) returns a plain-string 4xx instead of a
   *  broken stream; a throw after the stream opens becomes a final `error`
   *  frame whose payload is `{content}`. */
  private async stream(
    res: Response,
    gen: AsyncGenerator<ChatSseEvent>,
  ): Promise<void> {
    let next: IteratorResult<ChatSseEvent>;
    try {
      next = await gen.next();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 404 by exception type — the message text is localized (zh/en) and
      // must not be matched by substring.
      const status = e instanceof NotFoundException ? 404 : 400;
      res.status(status).type('text/plain').send(msg);
      return;
    }
    const sse = new SseWriter(res);
    // P2-3: heartbeat keeps idle proxies/load balancers from killing the
    // connection during long LLM calls; cleared exactly once in finally.
    const keepAlive = setInterval(() => sse.ping(), 15_000);
    try {
      while (!next.done) {
        // Client disconnected — stop consuming the LLM stream (the
        // generator's finally blocks run on abandon).
        if (sse.isClosed) break;
        await sse.send(next.value.type, next.value.data);
        try {
          next = await gen.next();
        } catch (e) {
          await sse.send('error', {
            content: e instanceof Error ? e.message : String(e),
          });
          break;
        }
      }
    } finally {
      clearInterval(keepAlive);
      sse.close();
    }
  }
}
