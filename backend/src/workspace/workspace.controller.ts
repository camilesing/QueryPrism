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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import type { CurrentUserInfo } from '../common/context/request-context';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkspaceService } from './workspace.service';
import {
  toWorkspaceSnake,
  toUwsItemSnake,
  toUserSnake,
  type WorkspaceSnake,
  type UwsItemSnake,
  type UserSnake,
} from './workspace-snake-mapper';

/** Plain typed body (no class-validator DTO class — global ValidationPipe
 *  has no metatype metadata for interfaces, passes the raw body through;
 *  same pattern as cycle 2 ai-model, §101). The frontend reuses the same
 *  `workspaceForm = {name, id}` reactive for create+update, sending
 *  `id: ''` on create (controller ignores it) and `id: <number>` on update. */
interface WorkspaceMutateBody {
  name: string;
  id?: string | number;
  description?: string | null;
}

interface UwsCreateBody {
  uid_list: number[];
  oid?: number; // admin only — non-admins are forced to the current workspace
  weight?: number; // admin only — non-admins always add ordinary members
}

interface UwsUpdateBody {
  uid: number; // singular, NOT uid_list (route 10 is single-user weight toggle)
  oid: number;
  weight: number;
}

interface UwsDeleteBody {
  uid_list: number[]; // batch (single = array of one)
  oid?: number; // admin only without oid → remove ALL bindings
}

@UseGuards(JwtAuthGuard)
@Controller('system/workspace')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  // ─── uws (user↔workspace binding) — declared BEFORE `:id` (§92) ────────

  // Route 6: polymorphic pager — with oid → workspace's users; without →
  // all users with ≥1 binding (system admin only). Items are USERS, not
  // workspaces. Non-admins are forced to their current workspace.
  @Get('uws/pager/:pageNum/:pageSize')
  @UseGuards(WsAdminGuard)
  async uwsPager(
    @Param('pageNum', ParseIntPipe) pageNum: number,
    @Param('pageSize', ParseIntPipe) pageSize: number,
    @CurrentUser() user: CurrentUserInfo,
    @Query('oid') oid?: string,
    @Query('keyword') keyword?: string,
  ): Promise<{ items: UwsItemSnake[]; total: number }> {
    const oidNum = oid !== undefined ? Number(oid) : undefined;
    const result = await this.workspaceService.uwsPager(
      pageNum,
      pageSize,
      user,
      oidNum,
      keyword,
    );
    return { items: result.items.map(toUwsItemSnake), total: result.total };
  }

  // Route 7: users NOT bound to workspace `oid` (add-member candidates).
  // Non-admins are forced to their current workspace.
  @Get('uws/option/pager/:pageNum/:pageSize')
  @UseGuards(WsAdminGuard)
  async uwsOptionPager(
    @Param('pageNum', ParseIntPipe) pageNum: number,
    @Param('pageSize', ParseIntPipe) pageSize: number,
    @CurrentUser() user: CurrentUserInfo,
    @Query('oid', ParseIntPipe) oid: number,
    @Query('keyword') keyword?: string,
  ): Promise<{ items: UserSnake[]; total: number }> {
    const result = await this.workspaceService.uwsOptionPager(
      pageNum,
      pageSize,
      user,
      oid,
      keyword,
    );
    return { items: result.items.map(toUserSnake), total: result.total };
  }

  // Route 8: find a SINGLE user by keyword (id/account/name). Used by
  // member/index.vue to resolve a typed-in identifier before uwsCreate.
  // `uws/option` 2-segment path doesn't collide with `:id` (1 segment).
  @Get('uws/option')
  @UseGuards(WsAdminGuard)
  async uwsOption(
    @Query('keyword') keyword?: string,
  ): Promise<UserSnake | null> {
    if (!keyword) return null;
    const user = await this.workspaceService.uwsOption(keyword);
    return user ? toUserSnake(user) : null;
  }

  // Route 9: bulk-ADD bindings. Non-admins: current workspace + weight 0.
  @Post('uws')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.UPDATE,
    detail: '批量绑定用户到工作空间',
  })
  async uwsCreate(
    @CurrentUser() user: CurrentUserInfo,
    @Body() dto: UwsCreateBody,
  ): Promise<{ success: true }> {
    return this.workspaceService.uwsCreate(dto, user);
  }

  // Route 10: single-user weight update (system admin only).
  @Put('uws')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.UPDATE,
    detail: '更新成员角色',
  })
  async uwsUpdate(@Body() dto: UwsUpdateBody): Promise<{ success: true }> {
    return this.workspaceService.uwsUpdate(dto);
  }

  // Route 11: bulk-REMOVE. Non-admins: current workspace, ordinary members
  // only. Admin without oid → remove ALL bindings (system-wide).
  @Delete('uws')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.UPDATE,
    detail: '解绑用户',
  })
  async uwsDelete(
    @CurrentUser() user: CurrentUserInfo,
    @Body() dto: UwsDeleteBody,
  ): Promise<{ success: true }> {
    return this.workspaceService.uwsDelete(dto, user);
  }

  // ─── archive (admin-only) — declared before the dynamic `:id` routes ────

  // GET /system/workspace/archived — soft-deleted workspaces.
  @Get('archived')
  @UseGuards(AdminGuard)
  async findArchived(): Promise<WorkspaceSnake[]> {
    const rows = await this.workspaceService.findArchived();
    return rows.map(toWorkspaceSnake);
  }

  // PUT /system/workspace/:id/restore — bring an archived workspace back.
  @Put(':id/restore')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.UPDATE,
    detail: '恢复归档工作空间',
  })
  async restore(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: true }> {
    return this.workspaceService.restore(id);
  }

  // DELETE /system/workspace/:id/permanent — hard delete (must be archived).
  @Delete(':id/permanent')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.DELETE,
    detail: '彻底删除工作空间',
  })
  async permanentRemove(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: true }> {
    return this.workspaceService.permanentRemove(id);
  }

  // ─── workspace CRUD (routes 1-5) — `:id` declared LAST (§92) ───────────

  @Get()
  @UseGuards(AdminGuard)
  async findAll(): Promise<WorkspaceSnake[]> {
    const rows = await this.workspaceService.findAll();
    return rows.map(toWorkspaceSnake);
  }

  @Get(':id')
  @UseGuards(AdminGuard)
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<WorkspaceSnake> {
    const row = await this.workspaceService.findOne(id);
    return toWorkspaceSnake(row);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.CREATE,
    resources: (r) => {
      const ws = r as { name?: string; id?: number };
      return [{ name: ws.name, originId: ws.id }];
    },
  })
  async create(@Body() dto: WorkspaceMutateBody): Promise<WorkspaceSnake> {
    const row = await this.workspaceService.create({
      name: dto.name,
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
    });
    return toWorkspaceSnake(row);
  }

  @Put()
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.UPDATE,
    detail: '更新工作空间',
  })
  async update(@Body() dto: WorkspaceMutateBody): Promise<WorkspaceSnake> {
    if (!dto.id) {
      throw new BadRequestException('id is required');
    }
    const row = await this.workspaceService.update({
      id: Number(dto.id),
      name: dto.name,
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
    });
    return toWorkspaceSnake(row);
  }

  // DELETE /system/workspace/:id — SOFT delete (archive). Permanent removal
  // lives at `:id/permanent` above and requires the workspace to be archived.
  @Delete(':id')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.WORKSPACE,
    type: OperationType.DELETE,
    detail: '归档工作空间',
  })
  async archive(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: true }> {
    return this.workspaceService.archive(id);
  }
}
