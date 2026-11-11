import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { DatasourceModule } from '../datasource/datasource.module';
import { ChatModule } from '../chat/chat.module';
import { RegressionTriggerModule } from './regression-trigger.module';
import { RegressionController } from './regression.controller';
import { RegressionService } from './regression.service';

// MetaDataImprove M6: semantic regression suite. Imports ChatModule to reuse
// the full NL2SQL pipeline (the point is re-GENERATING SQL under the current
// semantic layer). The trigger port lives in its own module (see
// regression-trigger.module) so SemanticModule can fire approval hooks
// without joining this import graph.
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AuditModule,
    DatasourceModule,
    ChatModule,
    RegressionTriggerModule,
  ],
  controllers: [RegressionController],
  providers: [RegressionService],
  exports: [RegressionService],
})
export class RegressionModule {}
