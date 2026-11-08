// appearance.module — branding read/save + image storage. Backed by
// SystemVariable (type='appearance') plus AppearanceFileService on disk.
import { Module } from '@nestjs/common';
import { AppearanceController } from './appearance.controller';
import { AppearanceService } from './appearance.service';
import { AppearanceFileService } from './appearance-file.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AppearanceController],
  providers: [AppearanceService, AppearanceFileService],
})
export class AppearanceModule {}
