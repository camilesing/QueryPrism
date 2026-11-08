// parameter.controller — reconciled to the /system/parameter surface.
// Mounted under system/parameter (→
// /api/v1/system/parameter), matching the frontend's calls. Class-level
// JwtAuthGuard keeps every route authenticated EXCEPT the public pre-login
// read below (the frontend hits /login before it has a token).
//
//   - GET /login   (getLogin) — PUBLIC (@Public): login-group params the
//     login page reads to pick the default SSO provider (login.default_login;
//     0 → local login).
//   - GET /chat    (getChat)  — auth: chat-group UI flags (chatConfig store).
//   - GET /        (findAll)  — auth (admin): all parameter rows; the admin
//     page filters client-side by pkey prefix (chat/login/platform).
//   - POST /       (save)    — auth (admin): multipart form whose `data` text
//     field is a JSON string of [{pkey, pval}].
//
// Grouping is the pkey prefix (login.*, chat.*, platform.*) — the same
// convention the frontend admin page uses. The {pkey, pval} list shape is
// the universal contract for every /system/parameter/* GET response.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { Public } from '../common/decorators/public.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { ParameterService, parseParameterItems } from './parameter.service';

@Controller('system/parameter')
@UseGuards(JwtAuthGuard)
export class ParameterController {
  constructor(private readonly parameterService: ParameterService) {}

  /** GET /system/parameter/login — public (pre-login) login-group params. */
  @Public()
  @Get('login')
  getLogin() {
    return this.parameterService.getGroup('login');
  }

  /** GET /system/parameter/chat — chat-group UI flags (post-login). */
  @Get('chat')
  getChat() {
    return this.parameterService.getGroup('chat');
  }

  /** GET /system/parameter — all parameter rows (admin). */
  @Get()
  @UseGuards(AdminGuard)
  findAll() {
    return this.parameterService.getAll();
  }

  /** POST /system/parameter — admin save. The frontend posts a multipart
   *  form whose `data` text field is a JSON string of [{pkey, pval}];
   *  AnyFilesInterceptor drives multer so the text field lands on req.body,
   *  then we parse + validate it before forwarding to the service. */
  @Post()
  @HttpCode(200) // POST /system/parameter returns 200, not 201.
  @UseGuards(AdminGuard)
  @UseInterceptors(AnyFilesInterceptor())
  @SystemLog({
    module: OperationModule.PARAMETER,
    type: OperationType.UPDATE,
    detail: '更新参数配置',
  })
  save(@Body('data') data: string | undefined) {
    const items = parseParameterItems(data);
    return this.parameterService.save(items);
  }
}
