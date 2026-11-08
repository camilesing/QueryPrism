// appearance.controller — branding read + admin save + image streaming.
//
//   - GET  /system/appearance/ui          PUBLIC — appearance KV pairs
//   - POST /system/appearance             ADMIN  — multipart data + files
//   - GET  /system/appearance/picture/:f  PUBLIC — stream a stored image
//
// The read + picture routes must stay unauthenticated: the login page fetches
// the theme/logo before any token exists. The save route opts into JWT +
// admin guards per-route (there is no global APP_GUARD).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../common/decorators/public.decorator';
import { AppearanceService } from './appearance.service';

@Controller('system/appearance')
export class AppearanceController {
  constructor(private readonly appearanceService: AppearanceService) {}

  /** GET /system/appearance/ui — public (pre-login) appearance KV pairs. */
  @Public()
  @Get('ui')
  getUi() {
    return this.appearanceService.getUi();
  }

  /** GET /system/appearance/picture/:file — public image stream. */
  @Public()
  @Get('picture/:file')
  async picture(
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.appearanceService.exists(file))) {
      res.status(404).send('File not found');
      return;
    }
    res.sendFile(this.appearanceService.pathFor(file), {
      headers: { 'Content-Type': this.appearanceService.mediaType(file) },
    });
  }

  /** POST /system/appearance — admin save (multipart `data` + `files`).
   *  Returns null so the frontend's `if (!res)` success branch runs. */
  @Post()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminGuard)
  @UseInterceptors(AnyFilesInterceptor())
  async save(
    @Body('data') data: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    await this.appearanceService.save(data, files ?? []);
    return null;
  }
}
