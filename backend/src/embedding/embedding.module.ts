// EmbeddingService is consumed by terminology/data-training/datasource
// recall paths. Registered globally so those modules can inject it without
// each re-importing this module. EmbeddingBackfillService runs once on
// startup (non-blocking) and on embedding.* re-enable flips to fill
// null-embedding rows across all four collections (gated by the runtime
// embedding.enabled / table_enabled parameters); EmbeddingController exposes
// a manual re-trigger for operators.
import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmbeddingService } from './embedding.service';
import { EmbeddingBackfillService } from './embedding-backfill.service';
import { EmbeddingController } from './embedding.controller';

@Global()
@Module({
  imports: [AuthModule],
  providers: [EmbeddingService, EmbeddingBackfillService],
  controllers: [EmbeddingController],
  exports: [EmbeddingService, EmbeddingBackfillService],
})
export class EmbeddingModule {}
