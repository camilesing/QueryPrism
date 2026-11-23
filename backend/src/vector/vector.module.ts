import { Global, Module } from '@nestjs/common';
import { VectorService } from './vector.service';

// Global: datasource / metric modules all need the vector store without
// importing this module explicitly.
@Global()
@Module({
  providers: [VectorService],
  exports: [VectorService],
})
export class VectorModule {}
