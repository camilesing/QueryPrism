// AssistantController — admin REST surface for the assistant-app page
// (type 0/1 basic/advanced). Rewrite (Phase 10d cycle 2).
//
// Routes use RESTful verbs with a snake_case wire shape (NOT action-style
// POST verbs like dashboard; the frontend api/embedded.ts uses
// GET/POST/PUT/DELETE bare). `@Controller('system/assistant')` prefix.
// Class-level `@UseGuards(JwtAuthGuard)`. Plain typed body interface
// (ValidationPipe passthrough, no DTO class). POST uses `@HttpCode(200)`
// (NestJS defaults to 201; the frontend expects 200). snake-mapper applied
// in controller (protects the service spec).
//
// 5 routes (reverse-engineered from frontend api/embedded.ts + iframe.vue —
// the active admin API; api/assistant.ts incl. `validate` is dead code):
//  1. GET    /                       → list of AssistantSnake (type!=4)
//  2. GET    /advanced_application   → list of {id, name} (type==1, pickers)
//  3. POST   /        body AssistantMutate → AssistantSnake (create)
//  4. PUT    /        body {id, ...}        → AssistantSnake (update, id-in-body)
//  5. DELETE /:id                        → {success:true}
//  6. GET    /picture/:file_id (Public) → streams the stored logo/float_icon
//  7. PATCH  /ui  multipart (data + files) → AssistantSnake (§A — Phase 11)
//
// DROPPED: GET /:id (dead — frontend getOne commented out), GET
// /validator (dead in frontend),
// GET /ds (runtime assistant-token route — embedded context, Phase 11).
// (PATCH /ui + GET /picture were previously "file-storage infra — deferred
// Phase 11"; Workstream A implements them with a local AssistantFileService.)
//
// @SystemLog on create (CREATE) / update (UPDATE) / delete (DELETE). resources
// callback extracts {name, originId: id} from raw handler return.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { AssistantTokenGuard } from '../auth/assistant-token.guard';
import { Public } from '../common/decorators/public.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { AssistantService } from './assistant.service';
import { AssistantFileService } from './assistant-file.service';
import type { AssistantMutateBody } from './assistant.service';
import {
  toAdvancedApplicationSnake,
  toAssistantSnake,
} from './assistant-snake-mapper';
import { tr } from '../common/i18n/translate';

@Controller('system/assistant')
@UseGuards(JwtAuthGuard)
export class AssistantController {
  constructor(
    private readonly assistantService: AssistantService,
    private readonly fileService: AssistantFileService,
  ) {}

  // --- read -------------------------------------------------------------

  @Get()
  @UseGuards(WsAdminGuard)
  async list() {
    const rows = await this.assistantService.list();
    return rows.map(toAssistantSnake);
  }

  @Get('advanced_application')
  @UseGuards(WsAdminGuard)
  async advancedApplication() {
    const rows = await this.assistantService.listAdvancedApplications();
    return rows.map(toAdvancedApplicationSnake);
  }

  /** GET /system/assistant/ds — runtime datasource list for an assistant
   *  token (embedded / advanced-application chat creator). @Public() skips the
   *  admin JWT; AssistantTokenGuard verifies `X-QUERYPRISM-ASSISTANT-TOKEN`. */
  @Public()
  @Get('ds')
  @UseGuards(AssistantTokenGuard)
  listRuntimeDatasources() {
    return this.assistantService.listRuntimeDatasources();
  }

  // --- create -----------------------------------------------------------

  @Post()
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.CREATE,
    detail: '新建助手',
    resources: (r) => {
      const a = r as { id: number; name: string };
      return [{ name: a.name, originId: a.id }];
    },
  })
  async create(@Body() body: AssistantMutateBody) {
    const row = await this.assistantService.create(body);
    return toAssistantSnake(row);
  }

  // --- update (id-in-body) ---------------------------------------------

  @Put()
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.UPDATE,
    detail: '更新助手',
    resources: (r) => {
      const a = r as { id: number; name: string };
      return [{ name: a.name, originId: a.id }];
    },
  })
  async update(@Body() body: AssistantMutateBody) {
    const row = await this.assistantService.update(body);
    return toAssistantSnake(row);
  }

  // --- delete -----------------------------------------------------------

  @Delete(':id')
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.DELETE,
    detail: '删除助手',
  })
  remove(@Param('id') id: string) {
    return this.assistantService.remove(Number(id));
  }

  // --- picture (public — embedded page loads logo without a JWT) ---------

  // §A: GET /system/assistant/picture/:file_id — streams a stored
  // logo/float_icon. @Public() exempts the route from the class-level
  // JwtAuthGuard: the embedded page renders in a cross-origin iframe
  // with no user token, so it must fetch its logo unauthenticated
  // (svg → image/svg+xml, else image/jpeg; 404 when the file_id isn't on
  // disk). The file_id opaque token lives in configuration.<flag> (set by
  // PATCH /ui).
  @Public()
  @Get('picture/:file_id')
  async picture(
    @Param('file_id') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.fileService.exists(fileId))) {
      res.status(404).send('File not found');
      return;
    }
    const mediaType = fileId.toLowerCase().endsWith('.svg')
      ? 'image/svg+xml'
      : 'image/jpeg';
    res.sendFile(this.fileService.pathFor(fileId), {
      headers: { 'Content-Type': mediaType },
    });
  }

  // --- ui (multipart upload of logo/float_icon) --------------------------

  // §A: PATCH /system/assistant/ui — merges the UI schema + optional file
  // uploads into configuration. The frontend (SetUi.vue:134) sends multipart
  // `data` (JSON-stringified AssistantUiSchema) + `files` (originalname
  // `"<name>,<flag>"`). Returns the updated assistant (snake) — the frontend
  // ignores the body and refreshes.
  @Patch('ui')
  @UseGuards(WsAdminGuard)
  @UseInterceptors(AnyFilesInterceptor())
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.UPDATE,
    detail: '更新助手界面',
    resources: (r) => {
      const a = r as { id: number; name: string };
      return [{ name: a.name, originId: a.id }];
    },
  })
  async updateUi(
    @Body('data') data: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    let uiSchema: Record<string, unknown>;
    try {
      uiSchema = JSON.parse(data ?? '{}') as Record<string, unknown>;
    } catch {
      throw new BadRequestException(tr('common.invalid_json_string'));
    }
    const row = await this.assistantService.updateUi(uiSchema, files ?? []);
    return toAssistantSnake(row);
  }
}
