// User controller. Mgmt returns are mapped to snake_case in the
// controller via toUserSnake (service returns raw Prisma rows WITH the
// userWorkspaces include so oid_list can be derived). /user/info keeps the
// 9b camelCase UserInfo shape (the auth contract, not the mgmt contract).
//
// Route ordering: every specific GET (info/ws/defaultPwd/template/pager/
// errorRecord/clearErrorRecord) is declared BEFORE @Get(':key') so the
// literal segments win over the single-param capture.
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
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import type { CurrentUserInfo } from '../common/context/request-context';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserService } from './user.service';
import { tr } from '../common/i18n/translate';
import { toUserSnake, type UserSnake } from './user-snake-mapper';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateLanguageDto } from './dto/update-language.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ─── self-service (current user) ──────────────────────────────────────

  @Get('info')
  info(@CurrentUser() user: CurrentUserInfo) {
    return this.userService.getInfo(user);
  }

  @Get('ws')
  wsOptions(@CurrentUser() user: CurrentUserInfo) {
    return this.userService.getWorkspaceOptions(user);
  }

  @Put('language')
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '切换语言',
  })
  updateOwnLanguage(
    @CurrentUser() user: CurrentUserInfo,
    @Body() dto: UpdateLanguageDto,
  ) {
    return this.userService.updateOwnLanguage(user, dto.language);
  }

  @Put('pwd')
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '修改密码',
  })
  changeOwnPassword(
    @CurrentUser() user: CurrentUserInfo,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.userService.changeOwnPassword(user, dto.pwd, dto.new_pwd);
  }

  @Put('ws/:oid')
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '切换工作空间',
  })
  switchWorkspace(
    @CurrentUser() user: CurrentUserInfo,
    @Param('oid') oid: string,
  ) {
    return this.userService.switchWorkspace(user, +oid);
  }

  // ─── mgmt extras (default password / template / import errors) ────────

  @Get('defaultPwd')
  @UseGuards(AdminGuard)
  getDefaultPwd() {
    return this.userService.getDefaultPwd();
  }

  @Get('template')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.EXPORT,
    detail: '导出用户模板',
  })
  async exportTemplate(@Res() res: Response) {
    const buffer = await this.userService.exportTemplate();
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="user-template.xlsx"',
    });
    res.send(buffer);
  }

  @Get('errorRecord/:key')
  @UseGuards(AdminGuard)
  async errorRecord(@Param('key') key: string, @Res() res: Response) {
    const path = await this.userService.resolveErrorRecord(key);
    res.download(path, key);
  }

  @Get('clearErrorRecord/:key')
  @UseGuards(AdminGuard)
  clearErrorRecord(@Param('key') key: string) {
    return this.userService.clearErrorRecord(key);
  }

  // ─── mgmt pager ({items, total} + snake) ─────────────────────────────

  @Get('pager/:n/:s')
  @UseGuards(AdminGuard)
  async pager(
    @Param('n') n: string,
    @Param('s') s: string,
    @Query('keyword') keyword?: string,
  ) {
    const { total, list } = await this.userService.pager({
      page: Number(n),
      pageSize: Number(s),
      keyword,
    });
    return { total, items: list.map((u) => toUserSnake(u)) };
  }

  // ─── mgmt CRUD (snake) ───────────────────────────────────────────────
  // NOTE: @Get(':key') MUST be declared after every other @Get('<literal>')
  // above so the literal segments win over the single-param capture.

  @Get(':key')
  @UseGuards(AdminGuard)
  async getOne(@Param('key') key: string) {
    const id = Number(key);
    if (!Number.isFinite(id)) {
      throw new BadRequestException(tr('user.invalid_user_id'));
    }
    const u = await this.userService.findOne(id);
    if (!u) {
      throw new BadRequestException(tr('user.user_key_not_found', { key }));
    }
    return toUserSnake(u);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.CREATE,
    resources: (r) => {
      const u = r as UserSnake;
      return [{ name: u.account, originId: u.id }];
    },
  })
  async create(@Body() dto: CreateUserDto) {
    const u = await this.userService.create(dto);
    return toUserSnake(u);
  }

  @Post('batchImport')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.IMPORT,
    detail: '批量导入用户',
  })
  importUsers(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(tr('user.excel_required'));
    }
    return this.userService.importUsers(file.buffer);
  }

  @Put()
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '更新用户',
    resources: (r) => {
      const u = r as UserSnake;
      return [{ name: u.account, originId: u.id }];
    },
  })
  async update(@Body() dto: UpdateUserDto) {
    if (dto.id === undefined) {
      throw new BadRequestException(tr('user.user_id_missing'));
    }
    const u = await this.userService.update(dto.id, dto);
    return toUserSnake(u);
  }

  // 2026-09 review P0-5: resetting ANY account (incl. the admin's) to the
  // public DEFAULT_PWD is a privilege escalation for non-admin callers —
  // AdminGuard (uid 1) is enforced server-side now. Self-service password
  // CHANGES go through PUT /user/pwd (changeOwnPassword) above.
  @Patch('pwd/:id')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.RESET,
    detail: '重置密码',
  })
  resetPassword(@Param('id') id: string) {
    return this.userService.resetToDefaultPassword(+id);
  }

  @Patch('status')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '更新状态',
    resources: (r) => {
      const u = r as UserSnake;
      return [{ name: u.account, originId: u.id }];
    },
  })
  async updateStatus(@Body() dto: UpdateStatusDto) {
    const u = await this.userService.updateStatus(dto.id, dto.status);
    return toUserSnake(u);
  }

  @Delete(':key')
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.DELETE,
    detail: '删除用户',
  })
  remove(@Param('key') key: string) {
    const id = Number(key);
    if (!Number.isFinite(id)) {
      throw new BadRequestException(tr('user.invalid_user_id'));
    }
    return this.userService.remove(id);
  }

  @Delete()
  @UseGuards(AdminGuard)
  @SystemLog({
    module: OperationModule.USER,
    type: OperationType.DELETE,
    detail: '批量删除用户',
  })
  removeBatch(@Body() body: { ids: number[] }) {
    return this.userService.removeBatch(body.ids);
  }
}
