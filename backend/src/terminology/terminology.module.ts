// TerminologyModule — Prisma + Auth for JwtAuthGuard; Vector/Embedding are
// @Global so no explicit import needed here. Service is exported so the chat
// pipeline (Phase 5) can inject it for RAG recall.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ImportExportModule } from '../common/import-export/import-export.module';
import { TerminologyController } from './terminology.controller';
import { TerminologyService } from './terminology.service';

@Module({
  imports: [DatabaseModule, AuthModule, ImportExportModule],
  controllers: [TerminologyController],
  providers: [TerminologyService],
  exports: [TerminologyService],
})
export class TerminologyModule {}
