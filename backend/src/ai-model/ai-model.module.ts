import { Module } from '@nestjs/common';
import { AiModelController } from './ai-model.controller';
import { AiModelService } from './ai-model.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { LlmModule } from '../llm/llm.module';

@Module({
  // LlmModule is one-way: AiModelService.testStatus calls back into
  // LlmService.testConnection for a real connectivity probe. LlmModule never
  // imports AiModelModule, so there is no cycle.
  imports: [DatabaseModule, AuthModule, LlmModule],
  controllers: [AiModelController],
  providers: [AiModelService],
  exports: [AiModelService],
})
export class AiModelModule {}
