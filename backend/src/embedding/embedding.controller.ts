// EmbeddingController — admin endpoints for the RAG embedding index. Behind
// JwtAuthGuard (system operators only).
import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { EmbeddingBackfillService } from './embedding-backfill.service';

@Controller('embedding')
@UseGuards(JwtAuthGuard)
export class EmbeddingController {
  constructor(private readonly backfillService: EmbeddingBackfillService) {}

  /** Manually (re)run the null-embedding backfill — useful after first
   *  configuring an embedding API key, without an app restart. */
  @Post('backfill')
  @SystemLog({
    module: OperationModule.EMBEDDING,
    type: OperationType.SYNC,
    detail: '手动触发 RAG embedding 回填',
  })
  backfill() {
    return this.backfillService.run();
  }
}
