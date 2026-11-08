// AdminGuard — method-level companion to JwtAuthGuard enforcing the
// hardcoded admin (uid 1). TS has no role system; uid 1 is the admin
// everywhere else already: RowPermissionService.isNormalUser (id !== 1),
// assistant-token.guard.ts's "uid 1 + account 'admin'" isAdmin equivalent,
// and the frontend userStore.isAdmin (uid === 1). This closes the 2026-09
// review P0-5 hole: PATCH /user/pwd/:id was guarded only by JwtAuthGuard, so
// ANY logged-in user could reset ANY account (incl. the admin's) to the
// default password. Admin-only surfaces (user management, appearance save,
// API keys, mcp integrations) also use this guard.
//
// MUST run after JwtAuthGuard (class- or method-level) — it reads the req.user
// the JWT guard attached; standalone use 403s because req.user is undefined.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { CurrentUserInfo } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';

/** The hardcoded admin uid (is_admin semantics). */
export const ADMIN_UID = 1;

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserInfo }>();
    if (req.user?.id !== ADMIN_UID) {
      throw new ForbiddenException(tr('auth.admin_required'));
    }
    return true;
  }
}
