import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { QuotaController } from './quota.controller';
import { QuotaService } from './quota.service';
import { QueryCacheService } from './query-cache.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [QuotaController],
  providers: [QuotaService, QueryCacheService],
  exports: [QuotaService, QueryCacheService],
})
export class QuotaModule {}
