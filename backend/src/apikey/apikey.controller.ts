// apikey.controller — Phase 10c cycle 1 §82/§88/§91/§92. Per-user
// programmatic-access keys, aligned to the `system/apikey` contract.
// The frontend (Apikey.vue) is the source
// of truth; the controller assembles the snake_case wire shape via the mapper
// (§77/§88) and delegates Prisma + AES to the service.
//
// Routes (5 — bare-array list, NO pager envelope; the frontend reads
// `state.tableData = res || []` directly, Apikey.vue:93):
//   - GET  /system/apikey            → ApiKeySnake[] (current user's keys,
//                                      secret_key MASKED to '')
//   - GET  /system/apikey/:id/secret → {id, secret_key} (reveal-on-demand,
//                                      ownership-scoped 404 — review P0-2)
//   - POST /system/apikey            → {id}         (server generates both keys)
//   - PUT  /system/apikey/status     → {success}    (body {id, status: boolean})
//   - DELETE /system/apikey/:id      → {success}
//
// `@HttpCode(200)` on POST/PUT (§91 — NestJS defaults POST to 201). The
// `status` literal is declared before any `:id` route would be (none here,
// but §92 ordering is defensive). PUT /status uses a plain typed body
// interface (no DTO class — global ValidationPipe has no metatype to
// validate, passes the raw `{id, status}` through, §101 same as ws_mapping).
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyService } from './apikey.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserInfo } from '../common/context/request-context';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import type { ApiKeySnake } from './apikey-snake-mapper';

/** Plain typed body for PUT /status (no DTO class — ValidationPipe
 *  passthrough, §101). The frontend sends `{id: row.id, status: row.status}`
 *  where status is the el-switch boolean (Apikey.vue:46-50). */
interface ApikeyStatusBody {
  id: number;
  status: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('system/apikey')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  findAll(@CurrentUser() user: CurrentUserInfo): Promise<ApiKeySnake[]> {
    return this.apiKeyService.findAll(user.id);
  }

  /** GET /system/apikey/:id/secret — reveal ONE key's plaintext secret on
   *  demand (review P0-2). The list masks secret_key; the frontend's
   *  show/copy actions fetch through here. Ownership-scoped (404, no
   *  existence leak). */
  @Get(':id/secret')
  revealSecret(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ id: number; secret_key: string }> {
    return this.apiKeyService.revealSecret(+id, user.id);
  }

  @Post()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.API_KEY,
    type: OperationType.CREATE,
    resources: (r) => [{ originId: (r as { id?: number }).id }],
  })
  create(@CurrentUser() user: CurrentUserInfo): Promise<{ id: number }> {
    return this.apiKeyService.create(user.id);
  }

  @Put('status')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.API_KEY,
    type: OperationType.UPDATE,
    detail: '更新 API Key 状态',
  })
  updateStatus(
    @Body() body: ApikeyStatusBody,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ success: true }> {
    return this.apiKeyService.updateStatus(body.id, user.id, body.status);
  }

  @Delete(':id')
  @SystemLog({
    module: OperationModule.API_KEY,
    type: OperationType.DELETE,
    detail: '删除 API Key',
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ success: true }> {
    return this.apiKeyService.remove(+id, user.id);
  }
}
