import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { SemanticModule } from '../semantic/semantic.module';
import { MetadataSyncController } from './metadata-sync.controller';
import { MetadataSyncService } from './metadata-sync.service';
import { MetadataSyncFetchService } from './metadata-sync-fetch.service';
import { MetadataSyncRunnerService } from './metadata-sync-runner.service';
import { MetadataSyncSchedulerService } from './metadata-sync-scheduler.service';

// MetaDataImprove M5: pull metadata from an external HTTP API or MCP server,
// manually or on a cron. Ingestion reuses SemanticModule's import services
// (same row format/validation/versioning as POST /meta/*). The scheduler owns
// its own `cron` jobs — no @nestjs/schedule dependency.
@Module({
  imports: [AuthModule, AuditModule, SemanticModule],
  controllers: [MetadataSyncController],
  providers: [
    MetadataSyncService,
    MetadataSyncFetchService,
    MetadataSyncRunnerService,
    MetadataSyncSchedulerService,
  ],
})
export class MetadataSyncModule {}
