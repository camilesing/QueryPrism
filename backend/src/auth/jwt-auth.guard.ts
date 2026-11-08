// Opt-in JWT guard. Reads the token from the configured header (default
// X-QUERYPRISM-TOKEN, matching the QueryPrism frontend), with an Authorization:
// Bearer fallback. Phase 9: the QueryPrism frontend sends
// `X-QUERYPRISM-TOKEN: Bearer <jwt>`, so a `Bearer ` prefix is stripped from
// EITHER header (older clients sent the raw token without the prefix; both
// forms are accepted). On success attaches the decoded user to req.user and to
// the ALS context.
//
// Phase 11F: honours the `@Public()` decorator (Reflector +
// getAllAndOverride). Previously `@Public()` was documentation-only (auth +
// license controllers used it on guard-less routes where the metadata had no
// effect); now it FUNCTIONALLY exempts a route from this guard so a method can
// opt out of the class-level JwtAuthGuard + run a different guard (e.g.
// AssistantTokenGuard on `/chat/assistant/start`). Safe: no existing route
// opts in under a class-level JwtAuthGuard, so behaviour is unchanged for them.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  requestContextStorage,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { tr } from '../common/i18n/translate';
import { PrismaService } from '../database/prisma.service';
import { ADMIN_UID } from './admin.guard';

interface JwtPayload {
  sub: number;
  account: string;
  oid: number;
  language: string;
  // Phase 9b: jsonwebtoken auto-adds iat/exp on sign; surfaced to
  // CurrentUserInfo so /user/info can return them.
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Phase 11F: skip when @Public() is set on the handler or class. Lets a
    // method under a class-level @UseGuards(JwtAuthGuard) opt out + run a
    // different guard (e.g. AssistantTokenGuard on /chat/assistant/start).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserInfo }>();
    const tokenKey =
      this.config.get<string>('jwt.tokenKey') ?? 'X-QUERYPRISM-TOKEN';
    const headerToken = req.header(tokenKey) ?? null;
    const bearer = req.header('authorization') ?? null;
    // Prefer X-QUERYPRISM-TOKEN; fall back to Authorization. Strip an optional
    // `Bearer ` prefix from whichever value is present.
    const candidate = headerToken ?? bearer;
    const token = candidate?.startsWith('Bearer ')
      ? candidate.slice(7)
      : candidate;

    if (!token) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException(tr('auth.token_expired'));
    }

    // Current workspace is DB-authoritative. The JWT oid is only a signed
    // snapshot taken at login, so trusting it made `PUT /user/ws/:oid`
    // require a re-login. Reading the row here also makes membership
    // revocation, account disabling and workspace archiving take effect
    // immediately.
    const row = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        account: true,
        language: true,
        oid: true,
        status: true,
        userWorkspaces: {
          select: {
            oid: true,
            weight: true,
            workspace: { select: { archivedAt: true } },
          },
        },
      },
    });
    if (!row || row.status !== 1) {
      throw new UnauthorizedException(tr('auth.account_missing_or_disabled'));
    }

    let weight = 0;
    if (row.id === ADMIN_UID) {
      // System admin may enter any existing workspace, including archived
      // ones (the archive page is the only place non-admins can never reach).
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: row.oid },
        select: { id: true },
      });
      if (!workspace) {
        throw new UnauthorizedException(tr('auth.workspace_missing_relogin'));
      }
    } else {
      const membership = row.userWorkspaces.find((m) => m.oid === row.oid);
      if (!membership) {
        throw new ForbiddenException(tr('auth.workspace_missing_or_forbidden'));
      }
      if (membership.workspace.archivedAt != null) {
        throw new ForbiddenException(tr('auth.workspace_archived'));
      }
      weight = membership.weight;
    }

    const user: CurrentUserInfo = {
      id: row.id,
      account: row.account,
      oid: row.oid,
      language: row.language,
      weight,
      iat: payload.iat,
      exp: payload.exp,
    };
    req.user = user;
    const store = requestContextStorage.getStore();
    if (store) {
      store.user = user;
    }
    return true;
  }
}
