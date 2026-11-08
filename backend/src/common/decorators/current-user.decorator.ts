// Param decorator that resolves the authenticated user attached to the
// request by JwtAuthGuard. Falls back to the AsyncLocalStorage context.
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  RequestContext,
  type CurrentUserInfo,
} from '../context/request-context';

export const CurrentUser = createParamDecorator(
  (_data: keyof CurrentUserInfo | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: CurrentUserInfo }>();
    const user: CurrentUserInfo | undefined =
      req.user ?? RequestContext.getUser();
    if (!user) {
      return undefined;
    }
    return _data ? user[_data] : user;
  },
);
