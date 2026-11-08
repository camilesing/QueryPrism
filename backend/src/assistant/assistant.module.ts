// AssistantModule — admin CRUD + public embedded-page lookup + dynamic CORS
// source + Phase 11F (§109/§68) embedded sign verification + assistant-token
// guard. Imports DatabaseModule + AuthModule for the JwtAuthGuard + JwtModule
// (decision §39: @SystemLog is SetMetadata read globally, AuditModule not
// needed; mirrors DashboardModule). AssistantService is exported so main.ts
// can pull it for the dynamic CORS origin function.
//
// Phase 11F placement (§121): AssistantTokenGuard + EmbeddedSignService live
// HERE (not AuthModule) to avoid A→B→A circular — AssistantModule already
// imports AuthModule (which exports JwtModule → JwtService injectable);
// AssistantService is local. Both are exported so ChatModule (which imports
// AssistantModule) can apply AssistantTokenGuard on /chat/assistant/start.
// EmbeddedSignService needs AssistantService? No — it takes PrismaService +
// JwtService + ConfigService (loads assistants cross-workspace directly). But
// AssistantTokenGuard needs AssistantService.decryptAppSecret (type-4 path) —
// same module, resolvable.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import {
  AssistantBootstrapController,
  AssistantPublicController,
} from './assistant-public.controller';
import { AssistantService } from './assistant.service';
import { AssistantFileService } from './assistant-file.service';
import { EmbeddedSignService } from './embedded-sign.service';
import { AssistantTokenGuard } from '../auth/assistant-token.guard';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    AssistantController,
    AssistantPublicController,
    AssistantBootstrapController,
  ],
  providers: [
    AssistantService,
    AssistantFileService,
    EmbeddedSignService,
    AssistantTokenGuard,
  ],
  exports: [
    AssistantService,
    AssistantFileService,
    AssistantTokenGuard,
    EmbeddedSignService,
  ],
})
export class AssistantModule {}
