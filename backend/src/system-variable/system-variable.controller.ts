// system-variable.controller — Phase 10c cycle 2 §82/§88/§91/§101. Aligned
// to the `sys_variable` contract.
// The frontend (variables/index.vue + RowAuth/FilterFiled permission) is the
// source of truth; the controller assembles the snake_case wire shape via the
// mapper (§77/§88) + delegates Prisma to the service.
//
// 4 action-style POST routes (§84 — `save`/`listAll`/`listPage/:n/:s`/`delete`
// are action verbs, NOT GET/PUT/DELETE). `@Controller('sys_variable')` — NO
// `system/` prefix (the outlier among the 5 10c modules; §82).
//   - POST /sys_variable/save          body {id?, name, var_type, value} → {success}
//   - POST /sys_variable/listAll       body {name?}              → SysVariableSnake[]
//   - POST /sys_variable/listPage/:n/:s body {name?}            → {items, total}
//   - POST /sys_variable/delete        body [id1, id2, ...]      → {success}
//
// `@HttpCode(200)` on all (§91 — POST defaults to 201). Plain typed bodies
// (no DTO classes — ValidationPipe passthrough, §101; the bare-array delete
// body has no metatype to validate, passes the raw array through, same as
// ws_mapping's `@Body() oids: string[]`).
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
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserInfo } from '../common/context/request-context';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemVariableService } from './system-variable.service';
import { SaveSysVariableDto } from './dto/save-sys-variable.dto';
import type { SysVariableSnake } from './sys-variable-snake-mapper';

/** Plain typed filter body for listAll/listPage (no DTO class — ValidationPipe
 *  passthrough, §101). Frontend sends `{}` (no filter) or `{name: kw}`. */
interface SysVariableFilterBody {
  name?: string;
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('sys_variable')
export class SystemVariableController {
  constructor(private readonly svc: SystemVariableService) {}

  @Post('listAll')
  @HttpCode(200)
  listAll(
    @Body() body: SysVariableFilterBody = {},
  ): Promise<SysVariableSnake[]> {
    return this.svc.listAll(body?.name);
  }

  @Post('listPage/:pageNum/:pageSize')
  @HttpCode(200)
  listPage(
    @Param('pageNum', ParseIntPipe) pageNum: number,
    @Param('pageSize', ParseIntPipe) pageSize: number,
    @Body() body: SysVariableFilterBody = {},
  ): Promise<{ items: SysVariableSnake[]; total: number }> {
    return this.svc.listPage(pageNum, pageSize, body?.name);
  }

  @Post('save')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SYSTEM_VARIABLE,
    type: OperationType.UPDATE,
    detail: '保存系统变量',
  })
  save(
    @Body() body: SaveSysVariableDto,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ success: true }> {
    return this.svc.save(body, user.id);
  }

  @Post('delete')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SYSTEM_VARIABLE,
    type: OperationType.DELETE,
    detail: '删除系统变量',
  })
  delete(@Body() ids: number[]): Promise<{ success: true }> {
    return this.svc.delete(ids);
  }
}
