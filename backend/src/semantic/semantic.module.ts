import { Module } from '@nestjs/common';
import { SemanticController } from './semantic.controller';
import { SemanticService } from './semantic.service';
import { SemanticImportService } from './semantic-import.service';
import { AuthModule } from '../auth/auth.module';
import { DatasourceModule } from '../datasource/datasource.module';

// AuthModule provides the JwtService behind the controller's JwtAuthGuard.
// Prisma is @Global via DatabaseModule so not listed. DatasourceModule feeds
// the M3.3 enum collector's live-connection probes (one session per run).
@Module({
  imports: [AuthModule, DatasourceModule],
  controllers: [SemanticController],
  providers: [SemanticService, SemanticImportService],
  exports: [SemanticService, SemanticImportService],
})
export class SemanticModule {}
