// McpService spec — verifies the six integration-authenticated tool handlers
// without bootstrapping the HTTP transport. Each handler receives the resolved
// McpToolContext (integration + synthetic user) directly; the caller wraps
// requestContextStorage.run where the handler reads RequestContext (lang).
// ChatService.runPipeline is faked with asyncFrom and drained by the real
// collectPipeline. g2ssr.render is mocked (no canvas).
import type { McpIntegration } from '@prisma/client';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { UnauthorizedException } from '@nestjs/common';
import { McpService, type McpToolContext } from './mcp.service';
import { ChatService } from '../chat/chat.service';
import { DatasourceService } from '../datasource/datasource.service';
import { AuditService } from '../audit/audit.service';
import { G2SsrClient } from './g2-ssr-client.service';
import { McpIntegrationService } from './mcp-integration.service';
import {
  requestContextStorage,
  RequestContext,
} from '../common/context/request-context';
import { OperationModule, OperationType } from '../audit/operation.enum';
import type {
  ChatSseEvent,
  ChatSseEventMap,
  ChatSseEventType,
} from '../chat/chat-sse-event';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

// --- helpers --------------------------------------------------------------

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

function happyEvents(): ChatSseEvent[] {
  return [
    ev('id', { id: 100 }),
    ev('question', { question: 'q' }),
    ev('datasource', {
      id: 1,
      datasource_name: 'main',
      engine_type: 'SQLite',
    }),
    ev('sql', { content: 'SELECT * FROM users' }),
    ev('brief', { brief: '用户数' }),
    ev('sql-data', { content: 'execute-success' }),
    ev('chart', {
      content: JSON.stringify({
        type: 'bar',
        title: '',
        axis: {
          x: { name: 'category', value: 'category' },
          y: [{ name: 'value', value: 'value' }],
        },
      }),
    }),
    ev('finish', {}),
  ];
}

const integration = {
  id: 1,
  oid: 1,
  name: 'agent',
  description: null,
  accessKey: 'qp_abc',
  secretKey: 'encrypted',
  createdBy: 1,
  status: 'active',
  lastUsedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} as McpIntegration;

function context(): McpToolContext {
  return {
    integration,
    user: {
      id: 1,
      account: 'mcp:agent',
      oid: 1,
      language: 'zh-CN',
      weight: 0,
    },
  };
}

function blockText(result: { content: unknown[] }, i = 0): string {
  const block = result.content[i] as { text?: string };
  return block.text ?? '';
}

function makeService() {
  const chatService = {
    start: jest.fn(),
    runPipeline: jest.fn(),
    getRecordChartData: jest.fn().mockResolvedValue({
      columns: ['category', 'value'],
      rows: [
        ['a', 10],
        ['b', 20],
      ],
      truncated: false,
      chartType: 'bar',
    }),
  };
  const datasourceService = {
    tableList: jest.fn(),
    fieldList: jest.fn(),
  };
  const integrationService = {
    authenticateBearer: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const g2ssr = { render: jest.fn() };
  const prisma = {
    datasource: { findMany: jest.fn() },
    chat: { findUnique: jest.fn() },
    aiModelWorkspaceMapping: {
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
    },
  };

  const service = new McpService(
    chatService as unknown as ChatService,
    datasourceService as unknown as DatasourceService,
    integrationService as unknown as McpIntegrationService,
    audit as unknown as AuditService,
    g2ssr as unknown as G2SsrClient,
    prisma as never,
  );
  return {
    service,
    chatService,
    datasourceService,
    integrationService,
    audit,
    g2ssr,
    prisma,
  };
}

function fakeResponse(): ServerResponse & {
  body?: string;
  capturedHeaders: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined as string | undefined,
    capturedHeaders: headers,
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    end(payload?: string) {
      res.body = payload;
      res.headersSent = true;
    },
  };
  return res as unknown as ServerResponse & {
    body?: string;
    capturedHeaders: Record<string, string>;
  };
}

// --- tests ----------------------------------------------------------------

describe('McpService tool handlers', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('list_datasources returns safe metadata scoped to the integration oid', async () => {
    const m = makeService();
    m.prisma.datasource.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'main',
        description: 'prod',
        type: 'postgresql',
        status: 'active',
        _count: { tables: 3 },
      },
    ]);

    const result = await m.service.handleListDatasources(context());

    expect(m.prisma.datasource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { oid: 1 } }),
    );
    expect(JSON.parse(blockText(result))).toEqual({
      datasources: [
        {
          id: 1,
          name: 'main',
          description: 'prod',
          type: 'postgresql',
          status: 'active',
          table_count: 3,
        },
      ],
    });
  });

  it('list_tables maps persisted tables to snake_case metadata', async () => {
    const m = makeService();
    m.datasourceService.tableList.mockResolvedValue([
      {
        id: 7,
        tableName: 'orders',
        tableComment: '订单',
        checked: true,
      },
    ]);

    const result = await m.service.handleListTables(2);

    expect(m.datasourceService.tableList).toHaveBeenCalledWith(2);
    expect(JSON.parse(blockText(result))).toEqual({
      datasource_id: 2,
      tables: [
        { id: 7, table_name: 'orders', table_comment: '订单', checked: true },
      ],
    });
  });

  it('describe_table returns the table plus its fields', async () => {
    const m = makeService();
    m.datasourceService.tableList.mockResolvedValue([
      { id: 7, tableName: 'orders', tableComment: '订单', checked: true },
    ]);
    m.datasourceService.fieldList.mockResolvedValue([
      {
        fieldName: 'id',
        fieldType: 'bigint',
        fieldComment: '主键',
        isPrimaryKey: true,
        checked: true,
      },
    ]);

    const result = await m.service.handleDescribeTable(2, 'ORDERS');

    expect(m.datasourceService.fieldList).toHaveBeenCalledWith(7);
    expect(JSON.parse(blockText(result))).toEqual({
      datasource_id: 2,
      table: {
        id: 7,
        table_name: 'orders',
        table_comment: '订单',
        checked: true,
      },
      fields: [
        {
          field_name: 'id',
          field_type: 'bigint',
          field_comment: '主键',
          is_primary_key: true,
          checked: true,
        },
      ],
    });
  });

  it('describe_table returns an error result for an unknown table', async () => {
    const m = makeService();
    m.datasourceService.tableList.mockResolvedValue([]);

    const result = await m.service.handleDescribeTable(2, 'missing');

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe('Table missing not found');
    expect(m.datasourceService.fieldList).not.toHaveBeenCalled();
  });

  it('list_models returns only non-secret workspace model fields', async () => {
    const m = makeService();
    m.prisma.aiModelWorkspaceMapping.findMany.mockResolvedValue([
      {
        weight: 10,
        model: {
          id: 5,
          name: 'gpt',
          baseModel: 'gpt-4o',
          supplier: 'openai',
          apiKey: 'secret',
        },
      },
    ]);

    const result = await m.service.handleListModels(context());

    expect(m.prisma.aiModelWorkspaceMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { oid: 1 } }),
    );
    expect(JSON.parse(blockText(result))).toEqual({
      models: [
        {
          id: 5,
          name: 'gpt',
          base_model: 'gpt-4o',
          supplier: 'openai',
          weight: 10,
        },
      ],
    });
    expect(blockText(result)).not.toContain('secret');
  });

  it('start_chat starts an origin:1 chat and audits the integration name', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 5 });

    const result = await m.service.handleStartChat(context(), 2, 'q');

    expect(m.chatService.start).toHaveBeenCalledWith({
      datasourceId: 2,
      title: 'q',
      origin: 1,
    });
    expect(JSON.parse(blockText(result))).toEqual({ chat_id: 5 });
    expect(m.audit.record).toHaveBeenCalledWith({
      module: OperationModule.MCP,
      type: OperationType.CREATE,
      status: 'success',
      detail: 'MCP start_chat (agent): chat 5',
    });
  });

  it('ask_question starts a chat (no chat_id) and assembles the result', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      datasource_id: 1,
    });

    expect(m.chatService.start).toHaveBeenCalledWith({
      datasourceId: 1,
      origin: 1,
    });
    expect(m.chatService.runPipeline).toHaveBeenCalledWith(7, 'q', undefined);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(blockText(result))).toEqual({
      record_id: 100,
      sql: 'SELECT * FROM users',
      brief: '用户数',
      data: {
        columns: ['category', 'value'],
        rows: [
          ['a', 10],
          ['b', 20],
        ],
        truncated: false,
      },
      chart_type: 'bar',
      chart_config: {
        type: 'bar',
        title: '',
        axis: {
          x: { name: 'category', value: 'category' },
          y: [{ name: 'value', value: 'value' }],
        },
      },
    });
  });

  it('ask_question uses a chat_id in the integration workspace without starting', async () => {
    const m = makeService();
    m.prisma.chat.findUnique.mockResolvedValue({ id: 9, oid: 1 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );

    await m.service.handleAskQuestion(context(), {
      question: 'q',
      chat_id: 9,
    });

    expect(m.chatService.start).not.toHaveBeenCalled();
    expect(m.chatService.runPipeline).toHaveBeenCalledWith(9, 'q', undefined);
  });

  it('ask_question rejects a chat from another workspace', async () => {
    const m = makeService();
    m.prisma.chat.findUnique.mockResolvedValue({ id: 9, oid: 2 });

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      chat_id: 9,
    });

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe(
      'The chat does not belong to this MCP workspace',
    );
    expect(m.chatService.runPipeline).not.toHaveBeenCalled();
  });

  it('ask_question errors when the chat does not exist', async () => {
    const m = makeService();
    m.prisma.chat.findUnique.mockResolvedValue(null);

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      chat_id: 999,
    });

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe('Chat ID is not exist');
    expect(m.chatService.runPipeline).not.toHaveBeenCalled();
  });

  it('ask_question drops a model_id that is not mapped to the workspace', async () => {
    const m = makeService();
    m.prisma.aiModelWorkspaceMapping.findFirst.mockResolvedValue(null);
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );

    await m.service.handleAskQuestion(context(), {
      question: 'q',
      model_id: 99,
    });

    expect(m.prisma.aiModelWorkspaceMapping.findFirst).toHaveBeenCalledWith({
      where: { modelId: 99, oid: 1 },
    });
    expect(m.chatService.runPipeline).toHaveBeenCalledWith(7, 'q', undefined);
  });

  it('ask_question passes a mapped model_id through', async () => {
    const m = makeService();
    m.prisma.aiModelWorkspaceMapping.findFirst.mockResolvedValue({ id: 1 });
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );

    await m.service.handleAskQuestion(context(), {
      question: 'q',
      model_id: 5,
    });

    expect(m.chatService.runPipeline).toHaveBeenCalledWith(7, 'q', 5);
  });

  it('ask_question renders a bar chart image when return_img=true', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );
    m.g2ssr.render.mockResolvedValue({ image: 'b64data' });

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      datasource_id: 1,
      return_img: true,
    });

    expect(m.g2ssr.render).toHaveBeenCalledWith({
      type: 'interval',
      data: [
        { category: 'a', value: 10 },
        { category: 'b', value: 20 },
      ],
      encode: { x: 'value', y: 'category' },
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'b64data',
      mimeType: 'image/png',
    });
  });

  it('ask_question skips image rendering for table charts', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.getRecordChartData.mockResolvedValue({
      columns: ['a'],
      rows: [[1]],
      truncated: false,
      chartType: 'table',
    });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>([
        ev('id', { id: 100 }),
        ev('sql', { content: 'SELECT 1' }),
        ev('sql-data', { content: 'execute-success' }),
        ev('chart', { content: JSON.stringify({}) }),
        ev('finish', {}),
      ]),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      datasource_id: 1,
      return_img: true,
    });

    expect(m.g2ssr.render).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('ask_question threads lang into the request context', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    let captured: string | undefined;
    m.chatService.runPipeline.mockImplementation(() => {
      captured = RequestContext.getUser()?.language;
      return asyncFrom<ChatSseEvent>([]);
    });
    const ctx = context();

    await requestContextStorage.run({ user: ctx.user }, () =>
      m.service.handleAskQuestion(ctx, {
        question: 'q',
        lang: 'en',
      }),
    );

    expect(captured).toBe('en');
  });

  it('ask_question surfaces a pipeline error as an error result', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>([
        ev('id', { id: 100 }),
        ev('error', { content: 'SQL执行失败' }),
        ev('finish', {}),
      ]),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
    });

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe('SQL执行失败');
  });
});

describe('McpService transport auth gate', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('returns 401 when the Authorization header is missing', async () => {
    const m = makeService();
    const res = fakeResponse();
    const req = { headers: {} } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(res.capturedHeaders['www-authenticate']).toContain('Bearer');
    expect(m.integrationService.authenticateBearer).not.toHaveBeenCalled();
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001 },
    });
  });

  it('returns 401 when the bearer token is rejected', async () => {
    const m = makeService();
    m.integrationService.authenticateBearer.mockRejectedValue(
      new UnauthorizedException('MCP token 无效'),
    );
    const res = fakeResponse();
    const req = {
      headers: { authorization: 'Bearer qp_bad.secret' },
    } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(m.integrationService.authenticateBearer).toHaveBeenCalledWith(
      'qp_bad.secret',
    );
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      error: { message: 'MCP token 无效' },
    });
  });
});

// --- tail-sweep (appended): transport happy path + residual auth/ask arms ---
// The MCP SDK server/transport are mocked so handleRequest's post-auth body
// (fresh transport + McpServer per request, tool registration, ALS run) is
// exercised without a real JSON-RPC roundtrip. jest.mock is hoisted above the
// imports, so this placement affects the whole file — no existing test
// constructs the real SDK classes.
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(),
}));

describe('McpService handleRequest (transport happy path)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('authenticates, builds a fresh stateless transport, registers all six tools, and hands the pre-parsed body over inside the ALS scope', async () => {
    const { McpServer } = jest.requireMock<{
      McpServer: jest.Mock;
    }>('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = jest.requireMock<{
      StreamableHTTPServerTransport: jest.Mock;
    }>('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const registerTool = jest.fn();
    const connect = jest.fn().mockResolvedValue(undefined);
    McpServer.mockImplementation(() => ({ registerTool, connect }));
    const transportHandle = jest.fn().mockResolvedValue(undefined);
    StreamableHTTPServerTransport.mockImplementation(() => ({
      handleRequest: transportHandle,
    }));

    const m = makeService();
    const user = context().user;
    m.integrationService.authenticateBearer.mockResolvedValue({
      integration,
      user,
    });
    const res = fakeResponse();
    const req = {
      headers: { authorization: 'Bearer qp_abc' },
    } as IncomingMessage;
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    await m.service.handleRequest(req, res, body);

    expect(m.integrationService.authenticateBearer).toHaveBeenCalledWith(
      'qp_abc',
    );
    expect(StreamableHTTPServerTransport).toHaveBeenCalledWith({
      sessionIdGenerator: undefined,
    });
    expect(McpServer).toHaveBeenCalledWith({
      name: 'queryprism',
      version: '1.0.0',
    });
    // all six tools registered on the fresh server
    expect(registerTool).toHaveBeenCalledTimes(6);
    expect(registerTool.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'list_datasources',
      'list_tables',
      'describe_table',
      'list_models',
      'start_chat',
      'ask_question',
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(transportHandle).toHaveBeenCalledWith(req, res, body);
  });

  it('maps a non-Unauthorized auth failure to the generic invalid-token 401', async () => {
    const m = makeService();
    m.integrationService.authenticateBearer.mockRejectedValue(
      new Error('db exploded'),
    );
    const res = fakeResponse();
    const req = {
      headers: { authorization: 'Bearer qp_abc' },
    } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      error: { message: 'Invalid MCP token' },
    });
  });

  it('treats a Bearer header with an empty token as missing (401)', async () => {
    const m = makeService();
    const res = fakeResponse();
    const req = {
      headers: { authorization: 'Bearer   ' },
    } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      error: { message: 'Missing MCP bearer token' },
    });
    expect(m.integrationService.authenticateBearer).not.toHaveBeenCalled();
  });

  it('treats a non-Bearer Authorization scheme as missing (401)', async () => {
    const m = makeService();
    const res = fakeResponse();
    const req = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(m.integrationService.authenticateBearer).not.toHaveBeenCalled();
  });

  it('writeUnauthorized is a no-op once headers were already sent', async () => {
    const m = makeService();
    m.integrationService.authenticateBearer.mockRejectedValue(
      new UnauthorizedException('nope'),
    );
    const res = fakeResponse();
    res.headersSent = true;
    const req = {
      headers: { authorization: 'Bearer qp_abc' },
    } as IncomingMessage;

    await m.service.handleRequest(req, res, {});

    expect(res.body).toBeUndefined();
    expect(res.statusCode).toBe(200); // untouched
  });
});

describe('McpService ask_question residual arms', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('resumes a clarify round via clarify_record_id (no new chat, same record)', async () => {
    const m = makeService();
    (m.chatService as { findChatIdByRecord?: jest.Mock }).findChatIdByRecord =
      jest.fn().mockResolvedValue(9);
    (m.chatService as { resumeClarified?: jest.Mock }).resumeClarified = jest
      .fn()
      .mockReturnValue(asyncFrom<ChatSseEvent>(happyEvents()));

    const result = await m.service.handleAskQuestion(context(), {
      clarify_record_id: 55,
      clarify_round: 1,
      clarify_table_ids: [2, 3],
      clarify_text: 'the sales one',
    });

    expect(m.chatService.findChatIdByRecord).toHaveBeenCalledWith(55);
    expect(m.chatService.resumeClarified).toHaveBeenCalledWith(
      55,
      { tableIds: [2, 3], text: 'the sales one', skip: undefined, round: 1 },
      undefined,
    );
    expect(m.chatService.start).not.toHaveBeenCalled();
    expect(JSON.parse(blockText(result)).record_id).toBe(100);
  });

  it('rejects a call with neither question nor clarify_record_id', async () => {
    const m = makeService();

    const result = await m.service.handleAskQuestion(context(), {});

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe(
      'question is required unless clarify_record_id is set',
    );
    expect(m.chatService.runPipeline).not.toHaveBeenCalled();
  });

  it('skips the lang override when no request context is running (no ALS)', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );

    // NOT wrapped in requestContextStorage.run → store?.user is undefined
    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      lang: 'en',
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(blockText(result)).record_id).toBe(100);
  });

  it('surfaces a clarify pause as needs_clarification instead of SQL', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>([
        ev('id', { id: 100 }),
        ev('clarify', {
          record_id: 100,
          round: 1,
          question: 'q',
          candidates: [
            {
              table_id: 2,
              table_name: 'sales',
              comment: '销售',
              meaning: '销售明细',
            },
            { table_id: 3, table_name: 'orders', comment: '订单' },
          ],
          max_select: 3,
          reason: 'missing schema',
          suggested_table_ids: [2],
        }),
        ev('finish', {}),
      ]),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
    });

    const payload = JSON.parse(blockText(result));
    expect(payload.needs_clarification).toBe(true);
    expect(payload.record_id).toBe(100);
    expect(payload.round).toBe(1);
    expect(payload.candidates).toHaveLength(2);
    expect(payload.max_select).toBe(3);
    expect(payload.reason).toBe('missing schema');
    expect(payload.suggested_table_ids).toEqual([2]);
    expect(payload.hint).toContain('clarify_record_id');
    // the gate pauses before SQL — no data block surfaced
    expect(payload.sql).toBeUndefined();
  });

  it('skips rendering when the chart spec cannot be built (missing axis mapping)', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>([
        ev('id', { id: 100 }),
        ev('sql', { content: 'SELECT 1' }),
        ev('sql-data', { content: 'execute-success' }),
        ev('chart', { content: JSON.stringify({}) }),
        ev('finish', {}),
      ]),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      return_img: true,
    });

    expect(m.g2ssr.render).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('skips the image block when g2-ssr returns no image', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>(happyEvents()),
    );
    m.g2ssr.render.mockResolvedValue({ image: null });

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      return_img: true,
    });

    expect(m.g2ssr.render).toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('stringifies a non-Error handler rejection (messageOf arm)', async () => {
    const m = makeService();
    m.chatService.start.mockRejectedValue('plain failure');

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
    });

    expect(result.isError).toBe(true);
    expect(blockText(result)).toBe('plain failure');
  });
});

describe('McpService registered tool closures (invoked from the transport)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  async function captureRegisteredCallbacks(): Promise<{
    callbacks: Array<(args?: unknown) => unknown>;
    m: ReturnType<typeof makeService>;
  }> {
    const { McpServer } = jest.requireMock<{
      McpServer: jest.Mock;
    }>('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = jest.requireMock<{
      StreamableHTTPServerTransport: jest.Mock;
    }>('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const registerTool = jest.fn();
    McpServer.mockImplementation(() => ({
      registerTool,
      connect: jest.fn().mockResolvedValue(undefined),
    }));
    StreamableHTTPServerTransport.mockImplementation(() => ({
      handleRequest: jest.fn().mockResolvedValue(undefined),
    }));
    const m = makeService();
    m.integrationService.authenticateBearer.mockResolvedValue({
      integration,
      user: context().user,
    });
    const req = {
      headers: { authorization: 'Bearer qp_abc' },
    } as IncomingMessage;
    await m.service.handleRequest(req, fakeResponse(), {});
    return {
      callbacks: registerTool.mock.calls.map(
        (c: [unknown, unknown, (args?: unknown) => unknown]) => c[2],
      ),
      m,
    };
  }

  it('every registered closure dispatches to its handler', async () => {
    const { callbacks, m } = await captureRegisteredCallbacks();
    expect(callbacks).toHaveLength(6);
    m.prisma.datasource.findMany.mockResolvedValue([]);
    m.datasourceService.tableList.mockResolvedValue([]);
    m.prisma.aiModelWorkspaceMapping.findMany.mockResolvedValue([]);
    m.chatService.start.mockResolvedValue({ id: 1 });
    m.chatService.runPipeline.mockReturnValue(asyncFrom<ChatSseEvent>([]));

    // list_datasources / list_models / start_chat take no (or optional) args
    await expect(callbacks[0]({})).resolves.toBeTruthy();
    await expect(callbacks[3]({})).resolves.toBeTruthy();
    await expect(
      callbacks[4]({ datasource_id: 1, title: 't' }),
    ).resolves.toBeTruthy();
    await expect(callbacks[1]({ datasource_id: 1 })).resolves.toBeTruthy();
    await expect(
      callbacks[2]({ datasource_id: 1, table_name: 'orders' }),
    ).resolves.toBeTruthy();
    await expect(callbacks[5]({ question: 'q' })).resolves.toBeTruthy();
  });

  it('closures surface handler failures as error results (catch arms)', async () => {
    const { callbacks, m } = await captureRegisteredCallbacks();
    m.prisma.datasource.findMany.mockRejectedValue(new Error('ds down'));
    m.datasourceService.tableList.mockRejectedValue(new Error('tables down'));
    m.prisma.aiModelWorkspaceMapping.findMany.mockRejectedValue(
      new Error('models down'),
    );
    m.chatService.start.mockRejectedValue(new Error('chat down'));

    for (const [cb, args, message] of [
      [callbacks[0], {}, 'ds down'],
      [callbacks[1], { datasource_id: 1 }, 'tables down'],
      [callbacks[3], {}, 'models down'],
      [callbacks[4], {}, 'chat down'],
    ] as Array<
      [(args?: unknown) => Promise<{ isError?: boolean }>, unknown, string]
    >) {
      const result = await cb(args);
      expect(result.isError).toBe(true);
      expect(blockText(result as { content: unknown[] })).toBe(message);
    }
  });

  it('ask_question skips image rendering when no chart event left a config (?? {} arm)', async () => {
    const m = makeService();
    m.chatService.start.mockResolvedValue({ id: 7 });
    m.chatService.runPipeline.mockReturnValue(
      asyncFrom<ChatSseEvent>([
        ev('id', { id: 100 }),
        ev('sql', { content: 'SELECT 1' }),
        ev('sql-data', { content: 'execute-success' }),
        ev('finish', {}),
      ]),
    );

    const result = await m.service.handleAskQuestion(context(), {
      question: 'q',
      return_img: true,
    });

    expect(m.g2ssr.render).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });
});
