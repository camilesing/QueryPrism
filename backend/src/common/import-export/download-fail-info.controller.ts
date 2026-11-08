// POST /system/download-fail-info. The import surfaces (terminology /
// data-training / custom-prompt Uploader) hand the frontend
// `error_excel_filename`; the "download failure list" button posts that
// filename back here.
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ImportErrorFileService } from './import-error-file.service';

@Controller('system')
@UseGuards(JwtAuthGuard)
export class DownloadFailInfoController {
  constructor(private readonly files: ImportErrorFileService) {}

  @Post('download-fail-info')
  @HttpCode(200)
  async download(
    @Body() body: { file?: string },
    @Res() res: Response,
  ): Promise<void> {
    if (!body?.file) {
      throw new BadRequestException('file is required');
    }
    const path = await this.files.resolveDownload(body.file);
    res.download(path, body.file);
  }
}
