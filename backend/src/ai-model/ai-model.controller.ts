// ai-model.controller — the frontend's
// modelApi (frontend/src/api/system.ts) reads ai-model rows from
// `/system/aimodel/*` (per-controller `system/` prefix, bare-name only
// for datasource/chat/user/login). snake_case mapping is applied here
// so the service returns raw rows + stays green.
//
// Two contract-specific behaviors surface here:
//   - `GET /:id` returns the model with `api_key` DECRYPTED to plaintext
//     (the admin edit form's API Key field needs it). List/create/update/
//     setDefault responses use list mode (omit api_key + surface has_api_key).
//   - `POST /`/`PUT /` receive `api_key`/`api_domain` as PLAINTEXT — the
//     service AES-256-GCM-encrypts apiKey at rest.
//   - SSE status: `POST /status` drains `testStatus` into an SSE
//     stream. Unlike chat's `{content}` error frames, the frontend's
//     Model.vue reads `data.error` (not `data.content`) for failures, so the
//     error frame carries an `error` key.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserInfo } from '../common/context/request-context';
import { SseWriter } from '../chat/sse-writer';
import { AiModelService } from './ai-model.service';
import {
  fromAiModelSnake,
  toAiModelSnake,
  type AiModelMutateSnake,
  type AiModelSnake,
} from './ai-model-snake-mapper';

// Plain typed body interfaces (no global ValidationPipe; DTOs are
// decorative). The frontend posts snake_case (`api_key`, `api_domain`,
// `base_model`, `model_type`, `config_list`); `fromAiModelSnake` normalizes
// both spellings to the service's camelCase payload. `supplier`/`model_type`/
// `protocol` arrive as numeric enum ids; the service coerces `String(...)` for
// the strict String columns.

interface StatusBody {
  id?: number;
}

@Controller('system/aimodel')
@UseGuards(JwtAuthGuard)
export class AiModelController {
  constructor(private readonly aiModelService: AiModelService) {}

  // ─── queries (specific literals BEFORE `:id`) ───────────────────────────

  /** GET /system/aimodel?keyword= — list all (list mode: no api_key). */
  @Get()
  @UseGuards(AdminGuard)
  async findAll(@Query('keyword') keyword?: string): Promise<AiModelSnake[]> {
    const rows = await this.aiModelService.findAll(keyword);
    return rows.map((r) => toAiModelSnake(r));
  }

  /** GET /system/aimodel/default — the currently default model (or null). */
  @Get('default')
  async findDefault(): Promise<AiModelSnake | null> {
    const row = await this.aiModelService.findDefault();
    return row ? toAiModelSnake(row) : null;
  }

  /** GET /system/aimodel/list/by_ws — models bound to the caller's workspace
   *  (oid derived from the JWT currentUser; the frontend sends no query). */
  @Get('list/by_ws')
  async listByWorkspace(
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<(AiModelSnake & { weight: number })[]> {
    const mappings = await this.aiModelService.listByWorkspace(user.oid);
    return mappings.map((m) => ({
      ...toAiModelSnake(m.model),
      weight: m.weight,
    }));
  }

  /** GET /system/aimodel/:id — returns the model with api_key DECRYPTED
   *  to plaintext (single mode). */
  @Get(':id')
  @UseGuards(AdminGuard)
  async query(@Param('id', ParseIntPipe) id: number): Promise<AiModelSnake> {
    const row = await this.aiModelService.query(id);
    return toAiModelSnake(row, { withApiKey: true });
  }

  // ─── mutations ─────────────────────────────────────────────────────────

  /** POST /system/aimodel — create (plaintext apiKey → AES-256-GCM at
   *  rest; response is list-mode, no api_key — frontend re-fetches). */
  @Post()
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.AI_MODEL,
    type: OperationType.CREATE,
    resources: (r) => {
      const m = r as AiModelSnake;
      return [{ name: m.name, originId: m.id }];
    },
  })
  async create(@Body() dto: AiModelMutateSnake): Promise<AiModelSnake> {
    const row = await this.aiModelService.create(
      fromAiModelSnake(dto) as never,
    );
    return toAiModelSnake(row);
  }

  /** PUT /system/aimodel (body contains id) — update only provided fields. */
  @Put()
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.AI_MODEL,
    type: OperationType.UPDATE,
    detail: '更新模型',
    resources: (r) => {
      const m = r as AiModelSnake;
      return [{ name: m.name, originId: m.id }];
    },
  })
  async update(@Body() dto: AiModelMutateSnake): Promise<AiModelSnake> {
    if (dto.id === undefined) {
      // 400-on-missing-id contract; the global exception filter
      // turns a thrown BadRequestException into a plain-string 400.
      throw new BadRequestException('id is required');
    }
    const payload = fromAiModelSnake(dto);
    const row = await this.aiModelService.update(dto.id, payload as never);
    return toAiModelSnake(row);
  }

  /** PUT /system/aimodel/default/:id — atomically set this model default. */
  @Put('default/:id')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.AI_MODEL,
    type: OperationType.UPDATE,
    detail: '设置默认模型',
    resources: (r) => {
      const m = r as AiModelSnake;
      return [{ name: m.name, originId: m.id }];
    },
  })
  async setDefault(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AiModelSnake> {
    const row = await this.aiModelService.setDefault(id);
    return toAiModelSnake(row);
  }

  /** DELETE /system/aimodel/:id — delete (cascade drops mappings). */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.AI_MODEL,
    type: OperationType.DELETE,
    detail: '删除模型',
  })
  async remove(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: true }> {
    return this.aiModelService.remove(id);
  }

  /** POST /system/aimodel/status — SSE connectivity test. The frontend
   *  (Model.vue modelCheckHandler) reads `data.error` (accumulate) +
   *  `data.content` (debug). `testStatus` returns a single `{success,
   *  message}`; drain it into one frame + close. A 404 for an unknown id
   *  returns a plain-string 404 before the stream opens (mirror chat's
   *  stream helper). */
  @Post('status')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async testStatus(
    @Body() body: StatusBody,
    @Res() res: Response,
  ): Promise<void> {
    let result: { success: boolean; message: string };
    try {
      result = await this.aiModelService.testStatus(Number(body.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('不存在') ? 404 : 400;
      res.status(status).type('text/plain').send(msg);
      return;
    }
    const sse = new SseWriter(res);
    if (result.success) {
      await sse.send('content', { content: result.message });
    } else {
      // frontend reads data.error — the error frame carries an `error` key.
      await sse.send('error', { error: result.message });
    }
    sse.close();
  }

  // ─── ws_mapping (model↔workspace binding, bulk string[]) ────────────────

  /** GET /system/aimodel/:id/ws_mapping — workspaces bound to this model, as
   *  `string[]` of oid (frontend `.includes(`${id}`)` is SameValueZero and
   *  would fail on a number[] compared against a string arg). */
  @Get(':id/ws_mapping')
  @UseGuards(AdminGuard)
  async listMappings(@Param('id', ParseIntPipe) id: number): Promise<string[]> {
    return this.aiModelService.listMappingsByModel(id);
  }

  /** POST /system/aimodel/:id/ws_mapping — bulk-ADD bindings (body `string[]`
   *  of oid; existing oids skipped to honour @@unique). */
  @Post(':id/ws_mapping')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.AI_MODEL,
    type: OperationType.UPDATE,
    detail: '批量绑定模型到工作空间',
  })
  async addMappings(
    @Param('id', ParseIntPipe) id: number,
    @Body() oids: string[],
  ): Promise<{ success: true }> {
    return this.aiModelService.addMappings(id, oids);
  }

  /** PUT /system/aimodel/:id/ws_mapping — bulk-REPLACE bindings (body
   *  `string[]` of oid; transaction wipes + recreates). */
  @Put(':id/ws_mapping')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async setMappings(
    @Param('id', ParseIntPipe) id: number,
    @Body() oids: string[],
  ): Promise<{ success: true }> {
    return this.aiModelService.setMappings(id, oids);
  }

  /** DELETE /system/aimodel/:id/ws_mapping — bulk-REMOVE bindings (body
   *  `string[]` of oid; idempotent). */
  @Delete(':id/ws_mapping')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async removeMappings(
    @Param('id', ParseIntPipe) id: number,
    @Body() oids: string[],
  ): Promise<{ success: true }> {
    return this.aiModelService.removeMappings(id, oids);
  }
}
