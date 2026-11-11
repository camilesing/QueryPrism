import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller';
import { SemanticModule } from '../semantic/semantic.module';
import { RegressionModule } from '../regression/regression.module';

// ApiKeyGuard's Prisma/Config deps are global; SemanticModule provides the
// import service. RegressionModule backs POST /meta/regression/run (M6 —
// the CI-facing trigger; it reuses the full chat pipeline, hence ChatModule
// joins the graph through it).
@Module({
  imports: [SemanticModule, RegressionModule],
  controllers: [MetaController],
})
export class MetaModule {}
