// McpIntegrationController — admin REST surface for the MCP page under
// 应用集成. Mirrors the EmbeddedController contract style:
//   GET    /system/mcp-integration?keyword=   → McpIntegrationSnake[]
//   POST   /system/mcp-integration            → McpIntegrationSnake + token
//   PUT    /system/mcp-integration            → McpIntegrationSnake (id-in-body)
//   DELETE /system/mcp-integration/:id        → {success:true}
//   GET    /system/mcp-integration/:id/secret → {token} (reveal on demand)
//   PATCH  /system/mcp-integration/secret/:id → {token} (rotate)
//
// Class-level JwtAuthGuard + WsAdminGuard: MCP credentials are workspace-admin
// only (same visibility as the rest of 应用集成). Every mutation is oid-scoped
// inside the service and audited under OperationModule.MCP; the token itself is
// never written to the audit log.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { McpIntegrationService } from './mcp-integration.service';
import type { McpIntegrationMutateBody } from './mcp-integration.service';
import { toMcpIntegrationSnake } from './mcp-integration-snake-mapper';

@Controller('system/mcp-integration')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class McpIntegrationController {
  constructor(private readonly service: McpIntegrationService) {}

  @Get()
  async list(@Query('keyword') keyword?: string) {
    const rows = await this.service.list(keyword);
    return rows.map((row) => toMcpIntegrationSnake(row));
  }

  @Post()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.MCP,
    type: OperationType.CREATE,
    detail: '新建 MCP 集成',
    resources: (r) => {
      const item = r as { id: number; name: string };
      return [{ name: item.name, originId: item.id }];
    },
  })
  async create(@Body() body: McpIntegrationMutateBody) {
    const { row, token } = await this.service.create(body);
    return toMcpIntegrationSnake(row, { token });
  }

  @Put()
  @SystemLog({
    module: OperationModule.MCP,
    type: OperationType.UPDATE,
    detail: '更新 MCP 集成',
    resources: (r) => {
      const item = r as { id: number; name: string };
      return [{ name: item.name, originId: item.id }];
    },
  })
  async update(@Body() body: McpIntegrationMutateBody) {
    const row = await this.service.update(body);
    return toMcpIntegrationSnake(row);
  }

  @Delete(':id')
  @SystemLog({
    module: OperationModule.MCP,
    type: OperationType.DELETE,
    detail: '删除 MCP 集成',
  })
  remove(@Param('id') id: string) {
    return this.service.remove(Number(id));
  }

  @Get(':id/secret')
  async revealSecret(@Param('id') id: string) {
    return { token: await this.service.revealToken(Number(id)) };
  }

  @Patch('secret/:id')
  @SystemLog({
    module: OperationModule.MCP,
    type: OperationType.RESET,
    detail: '重置 MCP 集成令牌',
  })
  async rotateSecret(@Param('id') id: string) {
    return { token: await this.service.rotateToken(Number(id)) };
  }
}
