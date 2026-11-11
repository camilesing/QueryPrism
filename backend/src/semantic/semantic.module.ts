import { Module } from '@nestjs/common';
import { SemanticController } from './semantic.controller';
import { SemanticService } from './semantic.service';
import { SemanticImportService } from './semantic-import.service';
import { MetricController } from './metric.controller';
import { StandardController } from './standard.controller';
import { MetricService } from './metric.service';
import { DataStandardService } from './standard.service';
import { MetricImportService } from './metric-import.service';
import { AuthModule } from '../auth/auth.module';
import { DatasourceModule } from '../datasource/datasource.module';
import { RegressionTriggerModule } from '../regression/regression-trigger.module';

// AuthModule provides the JwtService behind the controller's JwtAuthGuard.
// Prisma is @Global via DatabaseModule so not listed. DatasourceModule feeds
// the M3.3 enum collector's live-connection probes (one session per run).
// MetricService/DataStandardService (M4) sit on the shared governed-dictionary
// machinery (GovernedDictService + the SemanticChangeRequest table).
// RegressionTriggerModule (M6) is the approval→regression-run port; the
// runner itself lives in RegressionModule (which imports ChatModule — that
// asymmetry keeps this graph acyclic).
@Module({
  imports: [AuthModule, DatasourceModule, RegressionTriggerModule],
  controllers: [SemanticController, MetricController, StandardController],
  providers: [
    SemanticService,
    SemanticImportService,
    MetricService,
    DataStandardService,
    MetricImportService,
  ],
  exports: [
    SemanticService,
    SemanticImportService,
    MetricService,
    DataStandardService,
    MetricImportService,
  ],
})
export class SemanticModule {}
