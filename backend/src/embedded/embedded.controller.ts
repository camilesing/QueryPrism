// EmbeddedController — admin REST surface for the embedded-app management page
// (type==4 assistants). Phase 10d cycle 3.
//
// This controller implements the frontend contract
// (api/embedded.ts embeddedApi + views/system/embedded/Page.vue) purely:
//   1. GET    /:pageNum/:pageSize?keyword=  → {items: EmbeddedSnake[], total}
//   2. POST   /                body EmbeddedMutate → EmbeddedSnake (create)
//   3. PUT    /                body {id, ...}      → EmbeddedSnake (update, id-in-body)
//   4. DELETE /                body number[] (bare array) → {success:true} (batch)
//   5. PATCH  /secret/:id                          → {success:true} (rotate)
//
// app_secret is AES-encrypted at rest. The list DECRYPTS per row
// (Page.vue shows the plaintext + a copy button — R411-R419); create/update
// responses OMIT app_secret (the frontend re-fetches the list to see it).
// type 0/1 admin (cycle 2) NEVER returns plaintext — only this type-4 list does.
//
// `@Controller('system/embedded')` prefix; class-level `@UseGuards(JwtAuthGuard)`.
// Plain typed body interface. POST uses `@HttpCode(200)`.
// snake-mapper applied in controller (protects service spec). DELETE takes
// a bare JSON array body (api/embedded.ts: `request.delete(..., { data: params })`).
// @SystemLog on mutations (CREATE/UPDATE/DELETE); resources callback extracts
// {name, originId: id} from raw snake return on create/update.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { AssistantService } from '../assistant/assistant.service';
import type { EmbeddedMutateBody } from '../assistant/assistant.service';
import { toEmbeddedSnake } from './embedded-snake-mapper';

@Controller('system/embedded')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class EmbeddedController {
  constructor(private readonly assistantService: AssistantService) {}

  // --- read (pager + decrypt-on-read) -----------------------------------

  @Get(':pageNum/:pageSize')
  async list(
    @Param('pageNum') pageNum: string,
    @Param('pageSize') pageSize: string,
    @Query('keyword') keyword?: string,
  ) {
    const { items, total } = await this.assistantService.listEmbedded(
      Number(pageNum),
      Number(pageSize),
      keyword,
    );
    return {
      items: items.map((row) =>
        toEmbeddedSnake(row, {
          appSecretPlain: row.appSecret
            ? this.assistantService.decryptAppSecret(row.appSecret)
            : null,
        }),
      ),
      total,
    };
  }

  // --- create (app_secret null in response; frontend re-fetches list) ---

  @Post()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.CREATE,
    detail: '新建嵌入式应用',
    resources: (r) => {
      const a = r as { id: number; name: string };
      return [{ name: a.name, originId: a.id }];
    },
  })
  async create(@Body() body: EmbeddedMutateBody) {
    const row = await this.assistantService.createEmbedded(body);
    return toEmbeddedSnake(row); // app_secret null — frontend re-fetches list
  }

  // --- update (id-in-body; type immutable — ignored) -------------------

  @Put()
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.UPDATE,
    detail: '更新嵌入式应用',
    resources: (r) => {
      const a = r as { id: number; name: string };
      return [{ name: a.name, originId: a.id }];
    },
  })
  async update(@Body() body: EmbeddedMutateBody) {
    const row = await this.assistantService.updateEmbedded(body);
    return toEmbeddedSnake(row);
  }

  // --- delete (bare JSON array body — `request.delete(..., {data: ids})`) -

  @Delete()
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.DELETE,
    detail: '删除嵌入式应用',
  })
  remove(@Body() ids: number[]) {
    return this.assistantService.removeEmbedded(ids);
  }

  // --- rotate app_secret (PATCH /secret/:id → {success:true}) ---------

  @Patch('secret/:id')
  @SystemLog({
    module: OperationModule.ASSISTANT,
    type: OperationType.UPDATE,
    detail: '重置嵌入式应用密钥',
  })
  rotateSecret(@Param('id') id: string) {
    return this.assistantService.rotateSecret(Number(id));
  }
}
