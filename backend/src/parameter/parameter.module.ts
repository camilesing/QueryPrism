import { Module } from '@nestjs/common';
import { ParameterController } from './parameter.controller';
import { ParameterService } from './parameter.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ParameterController],
  providers: [ParameterService],
  exports: [ParameterService],
})
export class ParameterModule {}
