// ChatController spec — locks the CRUD → snake_case mapping (real
// toChatInfoSnake/toChatRecordSnake) and, above all, the private stream()
// SSE pump: a generator throw BEFORE the first event is a plain-text 404
// (NotFoundException) / 400 (anything else) with no headers committed; a
// throw mid-stream becomes a final `error` frame; sse.isClosed abandons the
// generator; the 15s heartbeat writes `: ping` comments while the LLM is
// idle and the interval is cleared when the stream ends. Wire format is
// asserted byte-for-byte (`data:<json>\n\n`, type merged into the JSON).
import type { Response } from 'express';
import { NotFoundException } from '@nestjs/common';
import type { Chat, ChatRecord } from '@prisma/client';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import type { ChatSseEvent } from './chat-sse-event';
import { ClarifyAnswerDto, DeleteChatDto, QuestionDto } from '../common/dtos';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';

const NOW = new Date('2026-01-02T03:04:05.678Z');
const ISO = '2026-01-02T03:04:05.678Z';

function mkChat(over: Partial<Chat> = {}): Chat {
  return {
    id: 1,
    createdAt: NOW,
    updatedAt: NOW,
    createBy: 9,
    brief: 'brief',
    chatType: 'chat',
    datasourceId: 3,
    engineType: 'PostgreSQL',
    dsType: 'sqlite',
    recommendedQuestion: null,
    recommendedGenerate: false,
    ...over,
  } as unknown as Chat;
}

function mkRecord(over: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 11,
    chatId: 1,
    createdAt: NOW,
    updatedAt: NOW,
    question: 'how many?',
    sqlAnswer: 'ans',
    sql: 'SELECT 1',
    chartAnswer: null,
    chart: null,
    analysis: null,
    analysisThinking: null,
    predict: null,
    predictContent: null,
    predictData: null,
    finish: false,
    error: null,
    runTime: 0,
    firstChat: true,
    recommendedQuestion: null,
    analysisRecordId: null,
    predictRecordId: null,
    regenerateRecordId: null,
    duration: null,
    totalTokens: null,
    clarify: null,
    clarifyAnswer: null,
    clarifyStatus: null,
    chartType: null,
    sqlExecResult: { columns: ['c'], rows: [[7]] },
    ...over,
  } as unknown as ChatRecord;
}

// --- fake express Response (SseWriter touches setHeader/flushHeaders/on/
//     write/end/writableEnded; the plain-text short-circuit touches
//     status/type/send) ------------------------------------------------------
interface FakeRes {
  set: jest.Mock;
  setHeader: jest.Mock;
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  write: jest.Mock;
  flushHeaders: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
  statusCode: number;
  writableEnded: boolean;
}

function mkRes(): { res: FakeRes; fireClose: () => void } {
  const closeListeners: Array<() => void> = [];
  const res: FakeRes = {
    set: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn(),
    write: jest.fn().mockReturnValue(true),
    flushHeaders: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    statusCode: 0,
    writableEnded: false,
  };
  res.on.mockImplementation((event: string, cb: () => void) => {
    if (event === 'close') closeListeners.push(cb);
  });
  return {
    res,
    /** Simulate the socket 'close' event (client disconnect). */
    fireClose: () => closeListeners.forEach((cb) => cb()),
  };
}

// --- async-generator stubs (object form: no `async function*` so ESLint's
//     require-await/require-yield stay quiet — same dodge as chat.service.spec;
//     the controller only ever calls .next()) --------------------------------
function sseFrom(
  next: () => Promise<IteratorResult<ChatSseEvent>>,
): AsyncGenerator<ChatSseEvent> {
  return { next } as unknown as AsyncGenerator<ChatSseEvent>;
}

/** Generator that yields the given events, then completes. */
function gen(...events: ChatSseEvent[]): AsyncGenerator<ChatSseEvent> {
  let i = 0;
  return sseFrom(() =>
    i < events.length
      ? Promise.resolve({ done: false, value: events[i++] })
      : Promise.resolve({ done: true, value: undefined }),
  );
}

/** Generator that rejects on the FIRST next() call. */
function firstThrowGen(err: unknown): AsyncGenerator<ChatSseEvent> {
  // non-Error rejections are deliberate — they exercise the String(e) branches
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return sseFrom(() => Promise.reject(err));
}

/** Generator that yields events, then rejects mid-stream. */
function midThrowGen(
  events: ChatSseEvent[],
  err: unknown,
): AsyncGenerator<ChatSseEvent> {
  let i = 0;
  let thrown = false;
  return sseFrom(() => {
    if (i < events.length) {
      return Promise.resolve({ done: false, value: events[i++] });
    }
    if (!thrown) {
      thrown = true;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(err);
    }
    return Promise.resolve({ done: true, value: undefined });
  });
}

// Node 26 + Jest 30.5.2 quirk: jest.useRealTimers() DELETES the timer globals
// instead of restoring them (typeof global.setInterval === 'undefined'), which
// would break every later test that opens an SSE stream. Capture the real
// timers up front and restore them manually after the fake-timer test.
const realTimers = {
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
};

function mkService() {
  return {
    findAll: jest.fn(),
    getRecentQuestions: jest.fn(),
    findOne: jest.fn(),
    getWithData: jest.fn(),
    start: jest.fn(),
    renameBrief: jest.fn(),
    remove: jest.fn(),
    runPipeline: jest.fn(),
    runRecommendQuestions: jest.fn(),
    runAnalysisByRid: jest.fn(),
    runPredictByRid: jest.fn(),
    resumeClarified: jest.fn(),
    findChatIdByRecord: jest.fn(),
    getRecordData: jest.fn(),
    getPredictData: jest.fn(),
    getRecordLogHistory: jest.fn(),
    getRecordUsage: jest.fn(),
    exportRecordExcel: jest.fn(),
  };
}

describe('ChatController', () => {
  let service: ReturnType<typeof mkService>;
  let controller: ChatController;

  beforeEach(() => {
    service = mkService();
    controller = new ChatController(service as unknown as ChatService);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (typeof global.setInterval !== 'function') {
      global.setInterval = realTimers.setInterval;
      global.clearInterval = realTimers.clearInterval;
    }
  });

  // ---------------- CRUD (snake_case mapping) ----------------------------

  it('findAll maps every chat through the real snake mappers', async () => {
    const chat = mkChat();
    const record = mkRecord();
    const datasource = { id: 3, name: 'main ds', type: 'mysql' };
    service.findAll.mockResolvedValue([
      { ...chat, records: [record], datasource },
      mkChat({
        id: 2,
        dsType: 'excel',
        records: undefined,
        datasource: undefined,
      }),
    ]);

    const out = await controller.findAll();

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 1,
      create_by: 9,
      datasource: 3,
      ds_type: 'mysql',
      datasource_name: 'main ds',
      datasource_exists: true,
      latest_record_time: ISO,
    });
    expect(out[0].records).toHaveLength(1);
    expect(out[0].records[0]).toMatchObject({
      id: 11,
      chat_id: 1,
      question: 'how many?',
      sql: 'SELECT 1',
      // findAll serves records WITHOUT data — the frontend GETs rows lazily
      data: null,
      create_time: ISO,
      finish_time: ISO,
    });
    // records ?? [] and datasource ?? null fallbacks
    expect(out[1].records).toEqual([]);
    expect(out[1].datasource_exists).toBe(false);
    expect(out[1].datasource_name).toBeNull();
    expect(out[1].ds_type).toBe('excel');
  });

  it('recentQuestions coerces the dsid param and delegates', async () => {
    service.getRecentQuestions.mockResolvedValue(['q1']);
    await expect(controller.recentQuestions('5')).resolves.toEqual(['q1']);
    expect(service.getRecentQuestions).toHaveBeenCalledWith(5);
  });

  it('findOne maps with withData:false and falls back to chat.dsType', async () => {
    const chat = mkChat({ datasource: undefined });
    const record = mkRecord({ chart: { type: 'column-chart' } as never });
    service.findOne.mockResolvedValue({ ...chat, records: [record] });

    const out = await controller.findOne('8');

    expect(service.findOne).toHaveBeenCalledWith(8);
    expect(out.datasource_exists).toBe(false);
    expect(out.ds_type).toBe('sqlite'); // joined datasource missing → Chat column
    expect(out.records[0].data).toBeNull();
    expect(out.records[0].chart).toBe('{"type":"column-chart"}');
  });

  it('findOne tolerates a chat with no records', async () => {
    service.findOne.mockResolvedValue({ ...mkChat(), records: undefined });
    const out = await controller.findOne('8');
    expect(out.records).toEqual([]);
    expect(out.latest_record_time).toBe(ISO); // falls back to chat create_time
  });

  it('getWithData serves the persisted sqlExecResult in record.data', async () => {
    const result = { columns: ['c'], rows: [[7]] };
    const chat = mkChat();
    service.getWithData.mockResolvedValue({
      ...chat,
      datasource: { id: 3, name: 'main ds', type: 'mysql' },
      records: [mkRecord({ sqlExecResult: result as never })],
    });

    const out = await controller.getWithData('8');

    expect(service.getWithData).toHaveBeenCalledWith(8);
    expect(out.records[0].data).toEqual(result);
    expect(out.ds_type).toBe('mysql');
  });

  it('getWithData also handles missing records/datasource', async () => {
    service.getWithData.mockResolvedValue({
      ...mkChat(),
      records: undefined,
      datasource: undefined,
    });
    const out = await controller.getWithData('8');
    expect(out.records).toEqual([]);
    expect(out.datasource_name).toBeNull();
  });

  it('start always creates a page chat: a client-supplied origin is ignored', async () => {
    const chat = mkChat();
    service.start.mockResolvedValue({
      ...chat,
      datasource: { id: 3, name: 'main ds', type: 'mysql' },
      records: [mkRecord()],
    });

    // origin 1 (MCP) makes the pipeline skip row-permission filtering — it
    // is a server-side marker and must never be the client's choice.
    const out = await controller.start({ datasource: 3, origin: 1 } as never);

    expect(service.start).toHaveBeenCalledWith({ datasourceId: 3, origin: 0 });
    expect(out.records[0].first_chat).toBe(true);
    expect(out.records[0].data).toBeNull();
    expect(out.datasource_name).toBe('main ds');
  });

  it('assistantStart hardcodes origin 2 and maps the seeded record', async () => {
    service.start.mockResolvedValue({
      ...mkChat(),
      datasource: null,
      records: [mkRecord()],
    });
    const out = await controller.assistantStart({ datasource: 4 });
    expect(service.start).toHaveBeenCalledWith({ datasourceId: 4, origin: 2 });
    expect(out.datasource_name).toBeNull();
    expect(out.records[0].chat_id).toBe(1);
  });

  it('rename delegates and echoes the new brief', async () => {
    service.renameBrief.mockResolvedValue(undefined);
    const dto = { id: 5, brief: 'renamed' };
    await expect(controller.rename(dto)).resolves.toBe('renamed');
    expect(service.renameBrief).toHaveBeenCalledWith(5, 'renamed');
  });

  it('remove prefers the authoritative body id', async () => {
    service.remove.mockResolvedValue(undefined);
    const dto = { id: 9, brief: 'x' } as DeleteChatDto;
    await controller.remove('7', dto);
    expect(service.remove).toHaveBeenCalledWith(9);
  });

  it('remove falls back to the path id when the body omits it', async () => {
    service.remove.mockResolvedValue(undefined);
    await controller.remove('7', {} as DeleteChatDto);
    expect(service.remove).toHaveBeenCalledWith(7);
  });

  // ---------------- SSE streaming ----------------------------------------

  it('question pumps generator events as data:<json>\\n\\n frames', async () => {
    service.runPipeline.mockReturnValue(
      gen({ type: 'id', data: { id: 11 } }, { type: 'finish', data: {} }),
    );
    const { res } = mkRes();
    const dto = { chat_id: 1, question: 'q', model_id: 2 } as QuestionDto;

    await controller.question(dto, res as unknown as Response);

    expect(service.runPipeline).toHaveBeenCalledWith(1, 'q', 2);
    // SSE headers committed BEFORE the first frame, status forced to 200
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream',
    );
    expect(res.statusCode).toBe(200);
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledTimes(2);
    // type is merged into the JSON top-level LAST
    expect(res.write).toHaveBeenNthCalledWith(
      1,
      'data:{"id":11,"type":"id"}\n\n',
    );
    expect(res.write).toHaveBeenNthCalledWith(2, 'data:{"type":"finish"}\n\n');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('question short-circuits 404 (plain text, no SSE) when the first pull throws NotFoundException', async () => {
    service.runPipeline.mockReturnValue(
      firstThrowGen(new NotFoundException('chat gone')),
    );
    const { res } = mkRes();
    const dto = { chat_id: 1, question: 'q' } as QuestionDto;

    await controller.question(dto, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('chat gone');
    // headers never committed → no half-open SSE stream
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('question short-circuits 400 for a generic first-pull Error', async () => {
    service.runPipeline.mockReturnValue(firstThrowGen(new Error('bad input')));
    const { res } = mkRes();
    await controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('bad input');
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('question stringifies a non-Error first-pull throw as 400', async () => {
    service.runPipeline.mockReturnValue(firstThrowGen('boom-string'));
    const { res } = mkRes();
    await controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('boom-string');
  });

  it('a mid-stream Error becomes a final error SSE frame', async () => {
    service.runPipeline.mockReturnValue(
      midThrowGen([{ type: 'id', data: { id: 1 } }], new Error('mid boom')),
    );
    const { res } = mkRes();
    await controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.write).toHaveBeenNthCalledWith(
      1,
      'data:{"id":1,"type":"id"}\n\n',
    );
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      'data:{"content":"mid boom","type":"error"}\n\n',
    );
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('a non-Error mid-stream throw is stringified into the error frame', async () => {
    // at least one event must be yielded first, otherwise the throw happens
    // on the FIRST pull and short-circuits to the plain-text 400 path
    service.runPipeline.mockReturnValue(
      midThrowGen([{ type: 'sql', data: { content: 'SELECT 1' } }], 42),
    );
    const { res } = mkRes();
    await controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      'data:{"content":"42","type":"error"}\n\n',
    );
  });

  it('stops consuming the generator once the response is closed', async () => {
    const { res, fireClose } = mkRes();
    let pull = 0;
    service.runPipeline.mockReturnValue(
      sseFrom(() => {
        pull += 1;
        if (pull === 1) {
          return Promise.resolve({
            done: false as const,
            value: { type: 'id', data: { id: 1 } },
          });
        }
        fireClose(); // client disconnects between the two events
        return Promise.resolve({
          done: false as const,
          value: { type: 'finish', data: {} },
        });
      }),
    );

    await controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );

    // first frame went out, the second never did, cleanup still ran
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith('data:{"id":1,"type":"id"}\n\n');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('writes : ping heartbeat comments every 15s and clears the interval on finish', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let pull = 0;
    service.runPipeline.mockReturnValue(
      sseFrom(() => {
        pull += 1;
        if (pull === 1) {
          return Promise.resolve({
            done: false as const,
            value: { type: 'id', data: { id: 1 } },
          });
        }
        if (pull === 2) {
          // long LLM call — the heartbeat must keep the line warm while this
          // next() is pending
          return gate.then(() => ({
            done: false as const,
            value: { type: 'finish', data: {} } as ChatSseEvent,
          }));
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
    );
    const { res } = mkRes();

    const done = controller.question(
      { chat_id: 1, question: 'q' },
      res as unknown as Response,
    );
    // let the stream open + the interval register, without aging any timer
    await jest.advanceTimersByTimeAsync(0);
    expect(res.flushHeaders).toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(15_000);
    expect(res.write).toHaveBeenCalledWith(': ping\n\n');
    await jest.advanceTimersByTimeAsync(15_000);
    // id frame + two pings
    expect(res.write).toHaveBeenCalledTimes(3);

    release();
    await done;
    expect(res.write).toHaveBeenLastCalledWith('data:{"type":"finish"}\n\n');

    // the finally block cleared the interval — no pings after the stream ended
    const writesAfterFinish = res.write.mock.calls.length;
    await jest.advanceTimersByTimeAsync(45_000);
    expect(res.write).toHaveBeenCalledTimes(writesAfterFinish);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['10', 10],
    ['2.9', 2],
    ['abc', 4],
    ['0', 4],
    [undefined, 4],
  ])(
    'recommendQuestions coerces articles_number=%p to cap %p',
    async (raw, cap) => {
      service.runRecommendQuestions.mockReturnValue(gen());
      const { res } = mkRes();
      await controller.recommendQuestions('7', raw, res as unknown as Response);
      expect(service.runRecommendQuestions).toHaveBeenCalledWith(7, cap);
    },
  );

  it('an empty generator still commits SSE headers and closes cleanly', async () => {
    service.runRecommendQuestions.mockReturnValue(gen());
    const { res } = mkRes();
    await controller.recommendQuestions('7', '3', res as unknown as Response);
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('analysis streams runAnalysisByRid(rid, model_id)', async () => {
    service.runAnalysisByRid.mockReturnValue(
      gen({ type: 'analysis_finish', data: {} }),
    );
    const { res } = mkRes();
    await controller.analysis('5', { model_id: 2 }, res as unknown as Response);
    expect(service.runAnalysisByRid).toHaveBeenCalledWith(5, 2);
    expect(res.write).toHaveBeenCalledWith(
      'data:{"type":"analysis_finish"}\n\n',
    );
  });

  it('predict streams runPredictByRid(rid, model_id)', async () => {
    service.runPredictByRid.mockReturnValue(
      gen({ type: 'predict_finish', data: {} }),
    );
    const { res } = mkRes();
    await controller.predict('5', {}, res as unknown as Response);
    expect(service.runPredictByRid).toHaveBeenCalledWith(5, undefined);
    expect(res.write).toHaveBeenCalledWith(
      'data:{"type":"predict_finish"}\n\n',
    );
  });

  it('clarify remaps the snake answer dto and resumes the SAME record', async () => {
    service.resumeClarified.mockReturnValue(gen({ type: 'finish', data: {} }));
    const { res } = mkRes();
    const dto = {
      table_ids: [1, 2],
      text: 'sales tables',
      skip: false,
      round: 1,
      model_id: 3,
    } as ClarifyAnswerDto;

    await controller.clarify('5', dto, res as unknown as Response);

    expect(service.resumeClarified).toHaveBeenCalledWith(
      5,
      { tableIds: [1, 2], text: 'sales tables', skip: false, round: 1 },
      3,
    );
    expect(res.write).toHaveBeenCalledWith('data:{"type":"finish"}\n\n');
  });

  // ---------------- record reads (rid-only) -------------------------------

  it('recordData resolves chatId from the record first', async () => {
    service.findChatIdByRecord.mockResolvedValue(4);
    service.getRecordData.mockResolvedValue({ columns: [], rows: [] });
    await controller.recordData('9');
    expect(service.findChatIdByRecord).toHaveBeenCalledWith(9);
    expect(service.getRecordData).toHaveBeenCalledWith(4, 9);
  });

  it('predictData resolves chatId from the record first', async () => {
    service.findChatIdByRecord.mockResolvedValue(4);
    service.getPredictData.mockResolvedValue({ ok: true });
    await expect(controller.predictData('9')).resolves.toEqual({ ok: true });
    expect(service.getPredictData).toHaveBeenCalledWith(4, 9);
  });

  it('recordLogs delegates with the numeric rid', async () => {
    service.getRecordLogHistory.mockResolvedValue({ steps: [] });
    await controller.recordLogs('9');
    expect(service.getRecordLogHistory).toHaveBeenCalledWith(9);
  });

  it('recordUsage resolves chatId from the record first', async () => {
    service.findChatIdByRecord.mockResolvedValue(4);
    service.getRecordUsage.mockResolvedValue({ duration: 1 });
    await controller.recordUsage('9');
    expect(service.getRecordUsage).toHaveBeenCalledWith(4, 9);
  });

  it('exportRecord sends the xlsx buffer with attachment headers', async () => {
    const buf = Buffer.from('xlsx-bytes');
    service.exportRecordExcel.mockResolvedValue(buf);
    const { res } = mkRes();

    await controller.exportRecord('9', '12', res as unknown as Response);

    expect(service.exportRecordExcel).toHaveBeenCalledWith(12, 9);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="chat-12-record-9.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  // ---------------- audit @SystemLog metadata -----------------------------

  it('start/assistantStart/rename derive audit resources from the handler result', () => {
    const cfg = (method: unknown) =>
      Reflect.getMetadata(SYSTEMLOG_KEY, method) as {
        resources: (r: unknown) => Array<{ name: string; originId: number }>;
      };
    // these closures only ever run inside the audit interceptor — invoke the
    // stored metadata directly to lock what they compute.
    expect(cfg(controller.start).resources({ id: 5 })).toEqual([
      { name: '新对话', originId: 5 },
    ]);
    expect(cfg(controller.assistantStart).resources({ id: 6 })).toEqual([
      { name: '助手对话', originId: 6 },
    ]);
    expect(
      cfg(controller.rename).resources({ id: 7, brief: 'renamed' }),
    ).toEqual([{ name: 'renamed', originId: 7 }]);
  });
});
