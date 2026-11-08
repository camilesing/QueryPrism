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
