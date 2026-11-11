import { Module } from '@nestjs/common';
import { DatasourceController } from './datasource.controller';
import { TableRelationController } from './table-relation.controller';
import { DatasourceService } from './datasource.service';
import { ExcelStoreService } from './excel-store.service';
import { DbConnectorFactory } from './db-connector/db-connector.factory';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { QuotaModule } from '../quota/quota.module';

// AuthModule is imported so the class-level @UseGuards(JwtAuthGuard) on both
// controllers can resolve JwtService (AuthModule exports JwtModule). §90.
// QuotaModule supplies the QueryCacheService behind execSql's M7 guards.
@Module({
  imports: [DatabaseModule, AuthModule, QuotaModule],
  controllers: [DatasourceController, TableRelationController],
  providers: [DatasourceService, DbConnectorFactory, ExcelStoreService],
  exports: [DatasourceService, DbConnectorFactory, ExcelStoreService],
})
export class DatasourceModule {}
