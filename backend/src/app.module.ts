import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { I18nValidationPipe } from 'nestjs-i18n';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
import { join } from 'path';
import { DatabaseModule } from './database/database.module';
import { DatasourceModule } from './datasource/datasource.module';
import { ChatModule } from './chat/chat.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { UserModule } from './user/user.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { AiModelModule } from './ai-model/ai-model.module';
import { SystemVariableModule } from './system-variable/system-variable.module';
import { ParameterModule } from './parameter/parameter.module';
import { ApiKeyModule } from './apikey/apikey.module';
import { VectorModule } from './vector/vector.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { TerminologyModule } from './terminology/terminology.module';
import { DataTrainingModule } from './data-training/data-training.module';
import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { AssistantModule } from './assistant/assistant.module';
import { EmbeddedModule } from './embedded/embedded.module';
import { CustomPromptModule } from './custom-prompt/custom-prompt.module';
import { PermissionModule } from './permission/permission.module';
import { RecommendedProblemModule } from './recommended-problem/recommended-problem.module';
import { AppearanceModule } from './appearance/appearance.module';
import { ImportExportModule } from './common/import-export/import-export.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RequestContextMiddleware } from './common/context/request-context';
import { UserLanguageResolver } from './common/i18n/user-language.resolver';
import { SystemLogInterceptor } from './audit/system-log.interceptor';
import configuration from './common/config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
    }),
    // Backend i18n: JSON dictionaries in src/i18n/{en,zh-CN}. Language per
    // request: user profile (UserLanguageResolver, ALS) → Accept-Language.
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: join(__dirname, '/i18n/'),
        watch: true,
      },
      resolvers: [UserLanguageResolver, AcceptLanguageResolver],
    }),
    DatabaseModule,
    AuthModule,
    AuditModule,
    UserModule,
    WorkspaceModule,
    AiModelModule,
    SystemVariableModule,
    ParameterModule,
    ApiKeyModule,
    // Phase 3 — RAG infra: VectorService (pgvector) + EmbeddingService.
    // Both are @Global modules, injected by terminology/data-training/
    // datasource recall paths without explicit re-import.
    VectorModule,
    EmbeddingModule,
    TerminologyModule,
    DataTrainingModule,
    DatasourceModule,
    ChatModule,
    // Phase 4 — Prompt templates + LLM Service + generators. Downstream of
    // datasource/terminology/data-training (for context assembly); used by
    // the Phase 5 chat pipeline and by AiModelService.testStatus.
    LlmModule,
    // Phase 6 — Dashboard builder (resource tree + canvas CRUD).
    DashboardModule,
    // Phase 7 — MCP server (Streamable HTTP transport + tools) + the
    // g2-ssr chart→PNG client. Mounted statelessly at /api/v1/mcp;
    // authenticated with per-integration Bearer tokens.
    McpModule,
    // Phase 8 — embedded Assistant (type 0/2/4; CRUD + public appId lookup +
    // dynamic CORS source). 1/3 dynamic API skipped (xpack-ish).
    AssistantModule,
    // Phase 10d cycle 3 — embedded-app management page (type==4 admin over
    // the same Assistant model; implemented from the frontend contract).
    EmbeddedModule,
    // Phase 10d cycle 4 — custom-prompt admin (per-type CRUD + Excel
    // import/export; implemented from the frontend contract).
    CustomPromptModule,
    // Phase 10d cycle 5 — ds_permission admin (rule groups + items;
    // implemented from the frontend contract).
    PermissionModule,
    // Phase 10d cycle 6 — recommended_problem admin (reuse existing
    // DsRecommendedProblem model; 3 routes: list/base/save replace-all).
    RecommendedProblemModule,
    // Shared Excel import-error file storage + POST /system/download-fail-info.
    ImportExportModule,
    // Appearance settings: public read (GET /system/appearance/ui) + admin
    // save/picture upload. Backed by SystemVariable (type='appearance') and a
    // local on-disk image store.
    AppearanceModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      // Localized class-validator messages (en/zh-CN via the i18n resolvers);
      // same options as the previous plain ValidationPipe. The error body
      // stays the plain-text string protocol (joined by HttpExceptionFilter).
      useValue: new I18nValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
    // Order matters: TransformInterceptor wraps the handler return into the
    // success envelope; SystemLogInterceptor runs closer to the handler, sees
    // the raw return, and records audit entries for @SystemLog handlers.
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SystemLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Establish the AsyncLocalStorage context for every request so the
    // JwtAuthGuard and audit services can read the current user anywhere.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
