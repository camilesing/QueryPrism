// permission.module — Phase 10d cycle 5 §111 (admin CRUD) + Phase 11A §111
// (runtime enforcement). Wires PermissionController (admin CRUD) +
// PermissionService (admin) + RowPermissionService (runtime filter resolver,
// consumed by ChatService). Imports DatabaseModule (PrismaService) +
// AuthModule (JwtAuthGuard). RowPermissionService is exported so ChatModule
// can inject it (ChatModule imports PermissionModule).
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { PermissionController } from './permission.controller';
import { PermissionService } from './permission.service';
import { RowPermissionService } from './row-permission.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [PermissionController],
  providers: [PermissionService, RowPermissionService],
  exports: [RowPermissionService],
})
export class PermissionModule {}
