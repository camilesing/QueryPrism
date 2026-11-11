import { Module } from '@nestjs/common';
import { RegressionTriggerService } from './regression-trigger.service';

// Neutral trigger port (MetaDataImprove M6) — see regression-trigger.service.
// Imported by SemanticModule (approval hooks) WITHOUT pulling in ChatModule,
// which RegressionModule does; that asymmetry is what keeps the module graph
// acyclic.
@Module({
  providers: [RegressionTriggerService],
  exports: [RegressionTriggerService],
})
export class RegressionTriggerModule {}
