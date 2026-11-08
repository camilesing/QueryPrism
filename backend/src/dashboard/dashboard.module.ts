// DashboardModule — Prisma + Auth for JwtAuthGuard. @SystemLog is just
// SetMetadata read by the global SystemLogInterceptor, so AuditModule isn't
// needed (mirrors TerminologyModule). Service exported for reuse by the MCP
// surface in Phase 7.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DatasourceModule } from '../datasource/datasource.module';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [DatabaseModule, AuthModule, DatasourceModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
