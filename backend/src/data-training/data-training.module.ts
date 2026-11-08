// DataTrainingModule — Prisma + Auth for JwtAuthGuard; Vector/Embedding are
// @Global so no explicit import needed here. Service exported for the chat
// pipeline (Phase 5) RAG recall.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ImportExportModule } from '../common/import-export/import-export.module';
import { DataTrainingController } from './data-training.controller';
import { DataTrainingService } from './data-training.service';

@Module({
  imports: [DatabaseModule, AuthModule, ImportExportModule],
  controllers: [DataTrainingController],
  providers: [DataTrainingService],
  exports: [DataTrainingService],
})
export class DataTrainingModule {}
