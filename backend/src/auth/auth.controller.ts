// Phase 9b: auth routes aligned to the frontend.
// - POST /login/access-token (public, form-urlencoded {username, password})
//   → {access_token, token_type, platform_info, need_change_pwd}. The
//   frontend UserStore.login reads `res.access_token` (the response
//   interceptor unwraps `data`); login/index.vue branches on
//   `need_change_pwd`.
// - POST /login/change-pwd (public, JSON {account, pwd, new_pwd}) —
//   first-login forced initial-password change (no token exists yet).
// Logout + /user/info live on their own controllers/routes (9b cycles 2-3).
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePwdDto } from './dto/change-pwd.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';

@Controller('login')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('access-token')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.AUTH,
    type: OperationType.LOGIN,
    detail: '登录',
  })
  login(@Body() dto: LoginDto) {
    // Map the stable internal {token, user, needChangePwd} to the frontend
    // {access_token, token_type, platform_info, need_change_pwd} shape
    // (UserStore.login reads access_token; need_change_pwd travels with an
    // EMPTY access_token — the store only persists a real token).
    return this.authService.login(dto.username, dto.password).then(
      ({
        token,
        needChangePwd,
      }): {
        access_token: string;
        token_type: string;
        platform_info: unknown;
        need_change_pwd: boolean;
      } => ({
        access_token: token,
        token_type: 'bearer',
        platform_info: null,
        need_change_pwd: needChangePwd,
      }),
    );
  }

  @Public()
  @Post('change-pwd')
  @HttpCode(200)
  @SystemLog({
    // The TS audit enum has no UPDATE_PWD, so UPDATE on the USER module is
    // the closest mapping for this password change.
    module: OperationModule.USER,
    type: OperationType.UPDATE,
    detail: '首次登录修改初始密码',
  })
  changePwd(@Body() dto: ChangePwdDto) {
    return this.authService.changePwd(dto.account, dto.pwd, dto.new_pwd);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.AUTH,
    type: OperationType.LOGOUT,
    detail: '退出登录',
  })
  logout() {
    return this.authService.logout();
  }
}
