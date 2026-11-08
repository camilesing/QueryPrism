// McpModule — the authenticated MCP server + its admin credential surface.
//
// McpController serves POST /api/v1/mcp (Bearer token → McpIntegrationService),
// McpIntegrationController serves /api/v1/system/mcp-integration (workspace-
// admin CRUD for MCP integrations). ChatService drives the NL2SQL pipeline,
// DatasourceService the table/field metadata, AuditService the MCP audit log.
// AuthModule supplies JwtAuthGuard/WsAdminGuard dependencies for the admin
// controller. ConfigService is global, so it injects without an explicit import.
import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { DatasourceModule } from '../datasource/datasource.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { McpController } from './mcp.controller';
import { McpIntegrationController } from './mcp-integration.controller';
import { McpService } from './mcp.service';
import { McpIntegrationService } from './mcp-integration.service';
import { G2SsrClient } from './g2-ssr-client.service';

@Module({
  imports: [ChatModule, DatasourceModule, AuthModule, AuditModule],
  controllers: [McpController, McpIntegrationController],
  providers: [McpService, McpIntegrationService, G2SsrClient],
})
export class McpModule {}
