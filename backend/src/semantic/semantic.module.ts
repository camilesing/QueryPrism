import { Module } from '@nestjs/common';
import { SemanticController } from './semantic.controller';
import { SemanticService } from './semantic.service';
import { AuthModule } from '../auth/auth.module';

// AuthModule provides the JwtService behind the controller's JwtAuthGuard.
// Prisma is @Global via DatabaseModule so not listed.
@Module({
  imports: [AuthModule],
  controllers: [SemanticController],
  providers: [SemanticService],
  exports: [SemanticService],
})
export class SemanticModule {}
