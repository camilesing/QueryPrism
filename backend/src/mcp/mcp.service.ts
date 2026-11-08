// McpService — authenticated MCP server (Streamable HTTP transport) + the six
// tools exposed to external agents.
//
// Auth: every request must carry `Authorization: Bearer <token>` where the
// token belongs to a workspace McpIntegration (mcp-integration.service.ts).
// The integration is resolved BEFORE the transport starts, so unauthenticated
// clients get a JSON-RPC 401 instead of `initialize`/`tools/list`. The tool
// closures capture the resolved integration/user (never instance fields —
// concurrent requests would race).
//
// Transports stay stateless (decision §45): the SDK throws when a stateless
// transport is reused, and Server.connect throws when already connected, so
// each request builds a fresh McpServer + transport and passes the pre-parsed
// body (Nest's json() body parser already consumed the stream).
//
// The whole transport is run inside requestContextStorage so ChatService /
// DatasourceService resolve the integration's workspace via currentOid().
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpIntegration } from '@prisma/client';
import { z } from 'zod';
import { ChatService } from '../chat/chat.service';
import { DatasourceService } from '../datasource/datasource.service';
import { AuditService } from '../audit/audit.service';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { G2SsrClient } from './g2-ssr-client.service';
import { collectPipeline } from './pipeline-collector';
import { buildG2Spec } from '../chart/chart-spec.builder';
import { chartObjectToFieldMapping } from '../chart/chart-object.builder';
import { PrismaService } from '../database/prisma.service';
import {
  RequestContext,
  requestContextStorage,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { McpIntegrationService } from './mcp-integration.service';
import { tr } from '../common/i18n/translate';

export interface AskQuestionArgs {
  question: string;
  chat_id?: number;
  datasource_id?: number;
  lang?: string;
  model_id?: number;
  return_img?: boolean;
}

/** Per-request auth context captured by every tool closure. */
export interface McpToolContext {
  integration: McpIntegration;
  user: CurrentUserInfo;
}

@Injectable()
export class McpService {
  constructor(
    private readonly chatService: ChatService,
    private readonly datasourceService: DatasourceService,
    private readonly integrationService: McpIntegrationService,
    private readonly audit: AuditService,
    private readonly g2ssr: G2SsrClient,
    private readonly prisma: PrismaService,
  ) {}

  /** Called by McpController per POST /api/v1/mcp. */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    const token = this.bearerToken(req);
    if (!token) {
      this.writeUnauthorized(res, 'Missing MCP bearer token');
      return;
    }

    let ctx: McpToolContext;
    try {
      const { integration, user } =
        await this.integrationService.authenticateBearer(token);
      ctx = { integration, user };
    } catch (e) {
      this.writeUnauthorized(
        res,
        e instanceof UnauthorizedException ? e.message : 'Invalid MCP token',
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcp = new McpServer({ name: 'queryprism', version: '1.0.0' });
    this.registerTools(mcp, ctx);

    // Run the transport inside the ALS context so every tool handler (and the
    // services it calls) sees the integration's workspace as currentOid().
    await requestContextStorage.run({ user: ctx.user }, async () => {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  }

  private registerTools(mcp: McpServer, ctx: McpToolContext): void {
    mcp.registerTool(
      'list_datasources',
      {
        description:
          'List datasources available to this MCP integration (id, name, type, table_count). Use the returned ids with list_tables / describe_table / start_chat / ask_question.',
        inputSchema: {},
      },
      () => this.handleListDatasources(ctx),
    );

    mcp.registerTool(
      'list_tables',
      {
        description:
          'List the tables (name + comment) of a datasource. Pass datasource_id from list_datasources.',
        inputSchema: { datasource_id: z.number().int().positive() },
      },
      ({ datasource_id }) => this.handleListTables(datasource_id),
    );

    mcp.registerTool(
      'describe_table',
      {
        description:
          'Describe a table: its comment plus every column (name, type, comment, primary key).',
        inputSchema: {
          datasource_id: z.number().int().positive(),
          table_name: z.string().min(1),
        },
      },
      ({ datasource_id, table_name }) =>
        this.handleDescribeTable(datasource_id, table_name),
    );

    mcp.registerTool(
      'list_models',
      {
        description:
          'List AI models mapped to this workspace (ids usable as ask_question model_id).',
        inputSchema: {},
      },
      () => this.handleListModels(ctx),
    );

    mcp.registerTool(
      'start_chat',
      {
        description:
          'Start a chat session in this workspace (origin: MCP). Returns { chat_id } for follow-up ask_question calls.',
        inputSchema: {
          datasource_id: z.number().int().positive().optional(),
          title: z.string().optional(),
        },
      },
      ({ datasource_id, title }) =>
        this.handleStartChat(ctx, datasource_id, title),
    );

    mcp.registerTool(
      'ask_question',
      {
        description:
          'Ask a natural-language question against this workspace data. Returns { record_id, sql, brief, data, chart_type, chart_config }. Set return_img=true to also return a PNG image block for bar/column/line/pie charts. lang is only a fallback (used for scripts like ja/ko the detector does not recognize) — the reply language follows the question text itself.',
        inputSchema: {
          question: z.string().min(1),
          chat_id: z.number().int().positive().optional(),
          datasource_id: z.number().int().positive().optional(),
          lang: z.string().optional(),
          model_id: z.number().int().positive().optional(),
          return_img: z.boolean().optional(),
        },
      },
      (args) =>
        this.handleAskQuestion(ctx, {
          question: args.question,
          chat_id: args.chat_id,
          datasource_id: args.datasource_id,
          lang: args.lang,
          model_id: args.model_id,
          return_img: args.return_img,
        }),
    );
  }

  // --- tool handlers -------------------------------------------------------

  async handleListDatasources(ctx: McpToolContext): Promise<CallToolResult> {
    try {
      const rows = await this.prisma.datasource.findMany({
        where: { oid: ctx.integration.oid },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          type: true,
          status: true,
          _count: { select: { tables: true } },
        },
      });
      return this.text(
        JSON.stringify({
          datasources: rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            type: row.type,
            status: row.status,
            table_count: row._count.tables,
          })),
        }),
      );
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  async handleListTables(datasourceId: number): Promise<CallToolResult> {
    try {
      const tables = await this.datasourceService.tableList(datasourceId);
      return this.text(
        JSON.stringify({
          datasource_id: datasourceId,
          tables: tables.map((table) => ({
            id: table.id,
            table_name: table.tableName,
            table_comment: table.tableComment,
            checked: table.checked,
          })),
        }),
      );
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  async handleDescribeTable(
    datasourceId: number,
    tableName: string,
  ): Promise<CallToolResult> {
    try {
      const tables = await this.datasourceService.tableList(datasourceId);
      const wanted = tableName.trim().toLowerCase();
      const table = tables.find(
        (row) => row.tableName.trim().toLowerCase() === wanted,
      );
      if (!table) {
        throw new BadRequestException(
          tr('mcp.table_not_found', { name: tableName }),
        );
      }
      const fields = await this.datasourceService.fieldList(table.id);
      return this.text(
        JSON.stringify({
          datasource_id: datasourceId,
          table: {
            id: table.id,
            table_name: table.tableName,
            table_comment: table.tableComment,
            checked: table.checked,
          },
          fields: fields.map((field) => ({
            field_name: field.fieldName,
            field_type: field.fieldType,
            field_comment: field.fieldComment,
            is_primary_key: field.isPrimaryKey,
            checked: field.checked,
          })),
        }),
      );
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  async handleListModels(ctx: McpToolContext): Promise<CallToolResult> {
    try {
      const mappings = await this.prisma.aiModelWorkspaceMapping.findMany({
        where: { oid: ctx.integration.oid },
        include: { model: true },
        orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
      });
      return this.text(
        JSON.stringify({
          models: mappings.map((mapping) => ({
            id: mapping.model.id,
            name: mapping.model.name,
            base_model: mapping.model.baseModel,
            supplier: mapping.model.supplier,
            weight: mapping.weight,
          })),
        }),
      );
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  async handleStartChat(
    ctx: McpToolContext,
    datasourceId?: number,
    title?: string,
  ): Promise<CallToolResult> {
    try {
      const chat = await this.chatService.start({
        datasourceId,
        title,
        origin: 1,
      });
      void this.audit.record({
        module: OperationModule.MCP,
        type: OperationType.CREATE,
        status: 'success',
        detail: `MCP start_chat (${ctx.integration.name}): chat ${chat.id}`,
      });
      return this.text(JSON.stringify({ chat_id: chat.id }));
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  async handleAskQuestion(
    ctx: McpToolContext,
    args: AskQuestionArgs,
  ): Promise<CallToolResult> {
    try {
      const oid = ctx.integration.oid;
      let chatId = args.chat_id;
      if (!chatId) {
        const chat = await this.chatService.start({
          datasourceId: args.datasource_id,
          origin: 1,
        });
        chatId = chat.id;
      } else {
        // The integration is workspace-bound: a caller-supplied chat_id may
        // only drive chats in the same workspace.
        const chat = await this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { id: true, oid: true },
        });
        if (!chat) {
          throw new BadRequestException('Chat ID is not exist');
        }
        if (chat.oid !== oid) {
          throw new BadRequestException(
            'The chat does not belong to this MCP workspace',
          );
        }
      }

      // A caller-supplied model_id is only honored when the model is mapped to
      // the integration's workspace; otherwise the pipeline falls back to the
      // workspace default.
      let modelId = args.model_id;
      if (modelId != null) {
        const mapping = await this.prisma.aiModelWorkspaceMapping.findFirst({
          where: { modelId, oid },
        });
        if (!mapping) {
          modelId = undefined;
        }
      }

      // Tool-level language override (the JWT path used to do this via
      // withAuth opts). Fallback only: the chat pipeline detects the reply
      // language from the question text (detect-language), so this value is
      // consulted just for scripts the detector doesn't recognize (ja/ko/…).
      // Mutating the per-request ALS store is safe: tools run sequentially
      // inside one HTTP request.
      if (args.lang) {
        const store = RequestContext.current();
        if (store?.user) {
          store.user = { ...store.user, language: args.lang };
        }
      }

      const collected = await collectPipeline(
        this.chatService.runPipeline(chatId, args.question, modelId),
      );
      if (collected.error) {
        return this.error(collected.error);
      }
      const recordData =
        collected.recordId != null
          ? await this.chatService.getRecordChartData(
              chatId,
              collected.recordId,
            )
          : { columns: [], rows: [], truncated: false, chartType: null };

      const result = this.text(
        JSON.stringify({
          record_id: collected.recordId,
          sql: collected.sql,
          brief: collected.brief,
          data: {
            columns: recordData.columns,
            rows: recordData.rows,
            truncated: recordData.truncated,
          },
          chart_type: recordData.chartType,
          chart_config: collected.chartConfig,
        }),
      );

      if (
        args.return_img &&
        recordData.chartType &&
        recordData.chartType !== 'table' &&
        recordData.rows.length > 0
      ) {
        const spec = buildG2Spec(
          recordData.chartType,
          chartObjectToFieldMapping(collected.chartConfig ?? {}),
          recordData.rows,
          recordData.columns,
        );
        if (spec) {
          const rendered = await this.g2ssr.render(spec);
          if (rendered.image) {
            result.content.push({
              type: 'image',
              data: rendered.image,
              mimeType: 'image/png',
            });
          }
        }
      }
      return result;
    } catch (e) {
      return this.error(this.messageOf(e));
    }
  }

  // --- transport helpers ---------------------------------------------------

  /** Extract `Authorization: Bearer <token>` (case-insensitive scheme). */
  private bearerToken(req: IncomingMessage): string | null {
    const value = req.headers.authorization;
    if (typeof value !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    const token = match?.[1]?.trim();
    return token ? token : null;
  }

  private writeUnauthorized(res: ServerResponse, message: string): void {
    if (res.headersSent) return;
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer realm="queryprism-mcp"');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message },
        id: null,
      }),
    );
  }

  private messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private text(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private error(message: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}
