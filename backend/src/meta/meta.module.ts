import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller';
import { SemanticModule } from '../semantic/semantic.module';

// ApiKeyGuard's Prisma/Config deps are global; SemanticModule provides the
// import service.
@Module({
  imports: [SemanticModule],
  controllers: [MetaController],
})
export class MetaModule {}
