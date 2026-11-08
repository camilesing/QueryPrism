// EmbeddedModule — admin REST surface for type==4 assistants (Phase 10d
// cycle 3). Imports AssistantModule (reuses AssistantService — the
// embedded routes are type-4 admin over the SAME Prisma model; no separate
// service exists) + AuthModule for the JwtAuthGuard. Decision:
// @SystemLog is SetMetadata read globally, AuditModule not needed.
//
// This module implements the frontend contract (api/embedded.ts embeddedApi +
// Page.vue).
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AssistantModule } from '../assistant/assistant.module';
import { EmbeddedController } from './embedded.controller';

@Module({
  imports: [AssistantModule, AuthModule],
  controllers: [EmbeddedController],
})
export class EmbeddedModule {}
