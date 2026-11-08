// permission.controller — Phase 10d cycle 5. Aligned to the `ds_permission`
// contract, implemented from the frontend contract (api/permissions.ts +
// views/system/permission/index.vue).
//
// 3 routes (all POST, all under the bare `/ds_permission` prefix — NOT
// action-style POST verbs like dashboard's `/list_resource`; RESTful bare
// verbs like embedded §109 / assistant §108, but the path prefix is
// `ds_permission` not `system/permission` because the frontend api file sends
// to `/ds_permission/...` directly):
//   - POST /ds_permission/list        → bare array of rule groups
//   - POST /ds_permission/save        (body PermissionSaveBody; id? → create|update)
//   - POST /ds_permission/delete/:id  (path param rule-group id)
//
// The frontend only checks promise resolution for save + delete (it re-fetches
// the list via handleSearch() after either). list returns a bare array — the
// global TransformInterceptor wraps it in {success,code,msg,data:[...]}; the
// frontend axios interceptor unwraps the outer envelope → bare array.
// `@HttpCode(200)` on save + delete — the wire contract is 200, not NestJS's
// default 201.
import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { PermissionService } from './permission.service';
import { SavePermissionDto } from './dto/save-permission.dto';

@UseGuards(JwtAuthGuard, WsAdminGuard)
@Controller('ds_permission')
export class PermissionController {
  constructor(private readonly permissionService: PermissionService) {}

  /** POST /ds_permission/list → bare array of snake-mapped rule groups (the
   *  service applies the snake-mapper; the controller returns it directly;
   *  TransformInterceptor wraps it in the success envelope; the frontend
   *  unwraps to `res` = the bare array, then `ruleList.value = res || []`). */
  @Post('list')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  list() {
    return this.permissionService.list();
  }

  /** POST /ds_permission/save → create (no id) or update (with id). Body is
   *  the snake_case SavePermissionDto (P2-2: real DTO — shape violations die
   *  as 400 here; the service keeps the semantic expression-tree validation
   *  from P0-1). The frontend doesn't read the response body — it re-fetches
   *  the list. Returns {id, name} for the @SystemLog resources callback. */
  @Post('save')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @SystemLog({
    module: OperationModule.PERMISSION,
    type: OperationType.CREATE,
    detail: '新建/更新数据源权限',
    resources: (r) => {
      const c = r as { id: number; name: string };
      return [{ name: c.name, originId: c.id }];
    },
  })
  save(@Body() body: SavePermissionDto) {
    return this.permissionService.save(body);
  }

  /** POST /ds_permission/delete/:id → delete the rule group + cascade its
   *  items. The frontend doesn't read the response body. Returns [{id}] for
   *  the @SystemLog DELETE resources callback. */
  @Post('delete/:id')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @SystemLog({
    module: OperationModule.PERMISSION,
    type: OperationType.DELETE,
    detail: '删除数据源权限',
    resources: (r) => {
      const arr = (r ?? []) as { id: number }[];
      return arr.map((x) => ({ name: String(x.id), originId: x.id }));
    },
  })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.permissionService.remove(id);
  }
}
