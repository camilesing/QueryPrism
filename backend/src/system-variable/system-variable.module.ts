import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { SystemVariableController } from './system-variable.controller';
import { SystemVariableService } from './system-variable.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SystemVariableController],
  providers: [SystemVariableService],
  exports: [SystemVariableService],
})
export class SystemVariableModule {}
