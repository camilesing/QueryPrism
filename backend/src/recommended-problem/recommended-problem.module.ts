// recommended-problem.module — Phase 10d cycle 6 §112. Wires
// RecommendedProblemController + RecommendedProblemService. Imports
// DatabaseModule (PrismaService) + AuthModule (JwtAuthGuard). NOT exported —
// the chat pipeline reads DsRecommendedProblem via Prisma directly
// (chat.service.ts getRecommendQuestions), not via this HTTP module. This
// module is admin-UI-only at the HTTP layer (RecommendedProblemConfigDialog).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { RecommendedProblemController } from './recommended-problem.controller';
import { RecommendedProblemService } from './recommended-problem.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [RecommendedProblemController],
  providers: [RecommendedProblemService],
})
export class RecommendedProblemModule {}
