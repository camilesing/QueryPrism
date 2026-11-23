// Local login/logout. Stateless JWT — logout is a client-side discard.
// bcryptjs for password verification against the User.password hash.
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { tr } from '../common/i18n/translate';
import { encrypt } from '../common/utils/aes';
import { PWD_REGEX, initialPwdDisabled } from './password-policy';
import { DEFAULT_PWD } from '../user/user.service';

export interface SafeUser {
  id: number;
  account: string;
  email: string | null;
  oid: number;
  status: number; // Phase 10: Int (1=active, 0=disabled)
  language: string;
}

function toSafeUser(u: {
  id: number;
  account: string;
  email: string | null;
  oid: number;
  status: number;
  language: string;
}): SafeUser {
  return {
    id: u.id,
    account: u.account,
    email: u.email,
    oid: u.oid,
    status: u.status,
    language: u.language,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // Phase 9b: stable internal API — returns {token, user, needChangePwd}.
  // Both the HTTP /login/access-token controller (maps to the frontend
  // {access_token, token_type, platform_info, need_change_pwd} shape) and the
  // MCP access_token tool (returns {token, oid, account, language}) call
  // this. Keeping the service shape stable decouples internal callers from the
  // frontend contract.
  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; user: SafeUser; needChangePwd: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { account: username },
    });
    if (!user || user.status !== 1) {
      // Phase 10: status is Int (1=active, 0=disabled).
      throw new UnauthorizedException(tr('auth.account_missing_or_disabled'));
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      throw new UnauthorizedException(tr('auth.wrong_credentials'));
    }
    // When login.initial_pwd_disabled is on and a non-admin
    // (uid≠1) user's stored hash still matches the initial password, no token
    // is issued — the frontend forces a /login/change-pwd round-trip first.
    // Passwords are stored as bcrypt hashes, so "is the
    // initial password" is a bcrypt.compare against the DEFAULT_PWD constant
    // ('123456', user.service).
    if (
      user.id !== 1 &&
      (await initialPwdDisabled(this.prisma)) &&
      (await bcrypt.compare(DEFAULT_PWD, user.password))
    ) {
      return { token: '', user: toSafeUser(user), needChangePwd: true };
    }
    // Login is refused when the user has no associated workspace: non-admin
    // users must have a membership row for their current oid, and the
    // workspace must not be archived.
    if (user.id !== 1) {
      const membership = await this.prisma.userWs.findUnique({
        where: { uid_oid: { uid: user.id, oid: user.oid } },
        select: { workspace: { select: { archivedAt: true } } },
      });
      if (!membership) {
        throw new UnauthorizedException(tr('auth.no_workspace_bound'));
      }
      if (membership.workspace.archivedAt != null) {
        throw new UnauthorizedException(tr('auth.workspace_archived'));
      }
    }
    // The oid claim is a snapshot; JwtAuthGuard treats User.oid from the DB as
    // authoritative, so switching workspaces no longer needs a re-login.
    const payload = {
      sub: user.id,
      account: user.account,
      oid: user.oid,
      language: user.language,
    };
    const token = await this.jwtService.signAsync(payload);
    return { token, user: toSafeUser(user), needChangePwd: false };
  }

  /** POST /login/change-pwd — first-login forced password
   *  change. Public (the caller has no token yet — login returned an empty
   *  access_token). Verifies the old password, enforces the pwd format,
   *  refuses the initial password as the new one while
   *  login.initial_pwd_disabled is on, then re-hashes with bcrypt. */
  async changePwd(
    account: string,
    pwd: string,
    newPassword: string,
  ): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { account } });
    if (
      !user ||
      user.status !== 1 ||
      !(await bcrypt.compare(pwd, user.password))
    ) {
      throw new UnauthorizedException(tr('auth.wrong_credentials'));
    }
    if (user.origin !== 0) {
      throw new UnauthorizedException(tr('auth.login_method_mismatch'));
    }
    if (!PWD_REGEX.test(newPassword)) {
      throw new BadRequestException(
        '密码格式错误（8-20位，需包含大写字母、小写字母、数字和特殊字符）',
      );
    }
    if (
      (await initialPwdDisabled(this.prisma)) &&
      newPassword === DEFAULT_PWD
    ) {
      throw new BadRequestException(tr('user.password_same_as_initial'));
    }
    await this.prisma.user.update({
      where: { id: user.id },
      // async hash like every other site: hashSync stalled the event loop
      // (and with it every SSE stream) for the whole bcrypt cost on a route
      // any logged-in user can call.
      data: { password: await bcrypt.hash(newPassword, 10) },
    });
    return { success: true };
  }

  /** Stateless logout — nothing to revoke server-side. Returns null so the
   *  frontend (UserStore.logout) treats `res` as falsy and falls
   *  through to the client-side #/login redirect — a truthy body would be
   *  used as window.location.href, breaking for local (non-SSO) users. */
  logout(): null {
    return null;
  }

  /** Fetch the current user's safe profile (for /auth/info). */
  async info(userId: number): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException(tr('user.not_found'));
    }
    return toSafeUser(user);
  }

  /** Hash a plaintext password (used by user module create/update/reset). */
  hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, 10);
  }

  /**
   * Sanity helper for API keys / secrets used by MCP-style access keys.
   * Returns the AES-encrypted secret (mirrors ai_model.api_key handling).
   */
  encryptSecret(plain: string): string {
    return encrypt(plain, this.config.get<string>('aes.key')!);
  }
}
