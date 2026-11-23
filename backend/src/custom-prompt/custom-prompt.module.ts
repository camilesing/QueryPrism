// custom-prompt.module — Phase 10d cycle 4 §110 (admin CRUD) + Phase 11 cycle
// 11B (runtime matching). Custom-prompt admin CRUD + Excel import/export +
// the chat-pipeline findCustomPrompts lookup. Imports DatabaseModule +
// AuthModule for the JwtAuthGuard (decision §39: @SystemLog is SetMetadata
// read globally, AuditModule not needed).
// CustomPromptService IS exported so LlmModule can inject it into
// AiQuestionService.buildSqlContext (§110 runtime custom_prompt injection).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ImportExportModule } from '../common/import-export/import-export.module';
import { CustomPromptController } from './custom-prompt.controller';
import { CustomPromptService } from './custom-prompt.service';

@Module({
  imports: [DatabaseModule, AuthModule, ImportExportModule],
  controllers: [CustomPromptController],
  providers: [CustomPromptService],
  exports: [CustomPromptService],
})
export class CustomPromptModule {}
