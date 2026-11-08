// WsAdminGuard — method/class-level companion to JwtAuthGuard enforcing the
// CURRENT workspace's admin role: the hardcoded system admin (uid 1) passes
// everywhere; everyone else needs a non-zero UserWs.weight for the workspace
// selected by User.oid. JwtAuthGuard resolves that weight from the DB on
// every request.
//
// MUST run after JwtAuthGuard (class- or method-level) — it reads the req.user
// the JWT guard attached.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { CurrentUserInfo } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import { ADMIN_UID } from './admin.guard';

@Injectable()
export class WsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserInfo }>();
    const user = req.user;
    if (user && (user.id === ADMIN_UID || (user.weight ?? 0) !== 0)) {
      return true;
    }
    throw new ForbiddenException(tr('auth.ws_admin_required'));
  }
}
