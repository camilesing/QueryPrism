// ImportExportModule — shared Excel import-error file storage + the
// /system/download-fail-info download surface. Feature modules (semantic /
// custom-prompt / user) import this module to write error workbooks; the
// controller is registered once here.
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { DownloadFailInfoController } from './download-fail-info.controller';
import { ImportErrorFileService } from './import-error-file.service';

@Module({
  imports: [AuthModule],
  controllers: [DownloadFailInfoController],
  providers: [ImportErrorFileService],
  exports: [ImportErrorFileService],
})
export class ImportExportModule {}
