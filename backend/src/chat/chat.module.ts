// ChatModule — Phase 5 chat surface. Pulls DatasourceService (direct inject,
// not re-exported by LlmModule) + the LLM generators + audit + auth +
// PermissionModule (Phase 11A §111 — RowPermissionService for runtime
// row-permission filter re-gen) + AssistantModule (Phase 11F §109/§68 — the
// AssistantTokenGuard applied to /chat/assistant/start is a provider in
// AssistantModule, exported so it's resolvable here). Prisma is @Global via
// DatabaseModule so not listed. SqlSafetyService is a local provider consumed
// only by ChatService. No circular risk: ChatModule → AssistantModule →
// AuthModule (one direction).
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SqlSafetyService } from './sql-safety.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AssistantModule } from '../assistant/assistant.module';
import { DatasourceModule } from '../datasource/datasource.module';
import { LlmModule } from '../llm/llm.module';
import { AuditModule } from '../audit/audit.module';
import { PermissionModule } from '../permission/permission.module';
import { TerminologyModule } from '../terminology/terminology.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AssistantModule,
    DatasourceModule,
    LlmModule,
    AuditModule,
    PermissionModule,
    TerminologyModule, // 3fd6fa86: keyword → synonym expansion in runCore
  ],
  controllers: [ChatController],
  providers: [ChatService, SqlSafetyService],
  exports: [ChatService],
})
export class ChatModule {}
