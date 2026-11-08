// LlmModule — Prompt templates + LLM Service + context assembly + the six
// generators. PrismaService (DatabaseModule) and ConfigService
// (ConfigModule.forRoot) are @Global, so only the three downstream service
// modules need importing for the AiQuestionService context gather. Exported
// for the Phase 5 chat pipeline to call the generators and for
// AiModelModule to reach LlmService.testConnection (one-way: LlmModule
// never imports AiModelModule).
import { Module } from '@nestjs/common';
import { DatasourceModule } from '../datasource/datasource.module';
import { TerminologyModule } from '../terminology/terminology.module';
import { DataTrainingModule } from '../data-training/data-training.module';
import { CustomPromptModule } from '../custom-prompt/custom-prompt.module';
import { LlmService } from './llm.service';
import { PromptService } from './prompt.service';
import { AiQuestionService } from './ai-question.service';
import { GeneratorService } from './generator.service';

@Module({
  imports: [
    DatasourceModule,
    TerminologyModule,
    DataTrainingModule,
    // §110: AiQuestionService.buildSqlContext injects the runtime-matched
    // custom-prompt body into the NL2SQL system prompt.
    CustomPromptModule,
  ],
  providers: [LlmService, PromptService, AiQuestionService, GeneratorService],
  exports: [LlmService, PromptService, AiQuestionService, GeneratorService],
})
export class LlmModule {}
