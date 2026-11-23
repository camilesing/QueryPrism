// EmbeddingService is consumed by the datasource / table recall paths.
// Registered globally so those modules can inject it without each
// re-importing this module. EmbeddingBackfillService runs once on startup
// (non-blocking) and on the embedding.table_enabled re-enable flip to fill
// null-embedding rows across the two collections; EmbeddingController
// exposes a manual re-trigger for operators.
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
