// AssistantTokenGuard (Phase 11F). Verifies `Assistant <jwt>` /
// `Embedded <jwt>` tokens and populates RequestContext.user +
// RequestContext.assistant.
//
// TWO schemes via the `X-QUERYPRISM-ASSISTANT-TOKEN` header:
//  - `Assistant <jwt>` (type 0/1): verify with the global `jwt.secret`.
//    Reads the `assistant_id` claim → loads the assistant
//    row → populates req.user = {id:payload.id, account:'queryprism-inner-assistant',
//    oid:payload.oid, language:'zh-CN'} (the virtual inner user;
//    payload.oid is the assistant's oid captured at bootstrap issue time).
//  - `Embedded <jwt>` (type 4): TWO-PASS — (1) `jwt.decode` (unverified) to get
//    the `id` claim, or fall back to `xor_decrypt(app_id)`
//    (key 0xABCD1234) to derive the embeddedId; (2) `jwt.verifyAsync` with
//    `decryptAppSecret(assistant.appSecret)` (the per-assistant
//    `app_secret`). Then loads the user by the `account` claim + populates
//    req.user with the USER's oid (the assistant's oid is replaced by the
//    session user's oid).
//
// Header enrichment: X-QUERYPRISM-ASSISTANT-CERTIFICATE (base64 +
// URL-decode), X-QUERYPRISM-ASSISTANT-ONLINE (str→bool), X-QUERYPRISM-HOST-ORIGIN.
//
// Placement: in AssistantModule (avoids A→B→A circular: AssistantModule
// already imports AuthModule which exports JwtModule → JwtService injectable;
// AssistantService local). Exported so ChatModule (which imports
// AssistantModule) can use it on `/chat/assistant/start`.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AssistantService } from '../assistant/assistant.service';
import { xorDecrypt } from '../assistant/embedded-sign.service';
import { tr } from '../common/i18n/translate';
import { PrismaService } from '../database/prisma.service';
import {
  requestContextStorage,
  type AssistantHeader,
  type CurrentUserInfo,
} from '../common/context/request-context';

/** Raw assistant-JWT payload (`{id, account, oid, assistant_id}`
 *  — NOT the admin `sub` shape). `id` is the virtual user id (null for type-4
 *  when no virtual was passed at bootstrap). */
interface AssistantJwtPayload {
  id: number | null;
  account: string;
  oid: number;
  assistant_id?: number;
  app_id?: string;
}

@Injectable()
export class AssistantTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly assistantService: AssistantService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserInfo }>();
    const header = req.header('x-queryprism-assistant-token');
    if (!header) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    const space = header.indexOf(' ');
    if (space <= 0 || space === header.length - 1) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    const scheme = header.slice(0, space);
    const param = header.slice(space + 1);

    if (scheme === 'Assistant') {
      await this.validateAssistant(req, param);
      return true;
    }
    if (scheme === 'Embedded') {
      await this.validateEmbedded(req, param);
      return true;
    }
    throw new UnauthorizedException(tr('auth.not_logged_in'));
  }

  /** `Assistant <jwt>` path (type 0/1) — verify with global jwt.secret. */
  private async validateAssistant(
    req: Request & { user?: CurrentUserInfo },
    token: string,
  ): Promise<void> {
    const secret = this.config.get<string>('jwt.secret');
    let payload: AssistantJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AssistantJwtPayload>(token, {
        secret,
      });
    } catch {
      throw new UnauthorizedException(tr('auth.token_expired'));
    }
    if (payload.assistant_id == null) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    const assistant = await this.prisma.assistant.findFirst({
      where: { id: payload.assistant_id, status: 'active' },
    });
    if (!assistant) {
      throw new UnauthorizedException(tr('auth.invalid_origin'));
    }
    // The session user uses payload.oid (captured at bootstrap issue
    // time) — NOT assistant.oid from the DB. The assistant row is only used
    // for the header enrichment (domain/configuration/etc.).
    const user: CurrentUserInfo = {
      id: payload.id ?? 0,
      account: payload.account,
      oid: payload.oid,
      language: 'zh-CN',
    };
    this.populateUser(req, user);
    this.populateAssistant(req, {
      id: assistant.id,
      oid: assistant.oid,
      type: assistant.type,
      domain: assistant.domain,
      configuration: assistant.configuration,
      appId: assistant.appId,
    });
  }

  /** `Embedded <jwt>` path (type 4) — two-pass verify with per-assistant
   *  app_secret. */
  private async validateEmbedded(
    req: Request & { user?: CurrentUserInfo },
    token: string,
  ): Promise<void> {
    // First pass: unverified decode to get the embeddedId (id claim, or
    // xor_decrypt(app_id) fallback).
    const unverified = this.jwtService.decode<AssistantJwtPayload>(token);
    if (!unverified) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    let embeddedId: number | undefined =
      typeof unverified.id === 'number' ? unverified.id : undefined;
    if (embeddedId === undefined && unverified.app_id) {
      embeddedId = xorDecrypt(unverified.app_id);
    }
    if (embeddedId === undefined) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    const assistant = await this.prisma.assistant.findFirst({
      where: { id: embeddedId, status: 'active' },
    });
    if (!assistant) {
      throw new UnauthorizedException(tr('auth.invalid_origin'));
    }
    // embedded 协议（app_secret + account）仅适用于页面嵌入（type=4）应用
    if (assistant.type !== 4) {
      throw new UnauthorizedException(tr('auth.invalid_embedded_type'));
    }
    // Second pass: verify with the decrypted per-assistant app_secret.
    const appSecret = this.assistantService.decryptAppSecret(
      assistant.appSecret,
    );
    let payload: AssistantJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AssistantJwtPayload>(token, {
        secret: appSecret,
      });
    } catch {
      throw new UnauthorizedException(tr('auth.token_expired'));
    }
    // Load the user by the account claim.
    if (!payload.account) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    const user = await this.prisma.user.findUnique({
      where: { account: payload.account },
    });
    if (!user || user.status !== 1) {
      throw new UnauthorizedException(tr('auth.account_missing_or_disabled'));
    }
    // 管理员账号不允许通过 embedded token 使用：app_secret 由集成方持有，
    // 泄露即可伪造 account=admin 的管理员身份（TS 无角色系统）
    if (user.id === 1 && user.account === 'admin') {
      throw new UnauthorizedException(
        tr('auth.admin_account_embedded_forbidden'),
      );
    }
    // The app secret lets its holder assert ANY account name, and any
    // workspace admin can create a type-4 app and read its secret. The
    // asserted user must therefore belong to the assistant's own workspace —
    // otherwise a token minted in one tenant could act as a user of another.
    const membership = await this.prisma.userWs.findFirst({
      where: { uid: user.id, oid: assistant.oid },
      select: { oid: true },
    });
    if (!membership) {
      throw new UnauthorizedException(
        tr('auth.workspace_missing_or_forbidden'),
      );
    }
    const userCtx: CurrentUserInfo = {
      id: user.id,
      account: user.account,
      oid: user.oid, // USER's oid, NOT the assistant's
      language: user.language,
    };
    this.populateUser(req, userCtx);
    this.populateAssistant(req, {
      id: assistant.id,
      oid: assistant.oid,
      type: assistant.type,
      domain: assistant.domain,
      configuration: assistant.configuration,
      appId: assistant.appId,
    });
  }

  /** Write the user to BOTH req.user (for handlers reading req) AND the ALS
   *  store (for services reading RequestContext.getUser / currentOid — mirrors
   *  JwtAuthGuard's dual write). The RequestContextMiddleware establishes the
   *  store before the guard runs, so getStore() is non-null here. */
  private populateUser(
    req: Request & { user?: CurrentUserInfo },
    user: CurrentUserInfo,
  ): void {
    req.user = user;
    const store = requestContextStorage.getStore();
    if (store) {
      store.user = user;
    }
  }

  /** Write the assistant header to the ALS store + apply header enrichment
   *  (certificate/online/host-origin). */
  private populateAssistant(
    req: Request,
    base: Omit<AssistantHeader, 'certificate' | 'online' | 'requestOrigin'>,
  ): void {
    const certificateHeader = req.header('x-queryprism-assistant-certificate');
    const onlineHeader = req.header('x-queryprism-assistant-online');
    const hostOrigin = req.header('x-queryprism-host-origin');
    const assistant: AssistantHeader = { ...base };
    if (certificateHeader) {
      assistant.certificate = this.decodeCertificate(certificateHeader);
    }
    if (onlineHeader != null) {
      // 'true'/'1' → true, anything else → false.
      assistant.online = onlineHeader === 'true' || onlineHeader === '1';
    }
    if (hostOrigin) {
      assistant.requestOrigin = hostOrigin;
    }
    const store = requestContextStorage.getStore();
    if (store) {
      store.assistant = assistant;
    }
  }

  /** Base64-decode then URL-decode the certificate. Wrapped so a malformed
   *  cert doesn't 401 the whole request (the cert is informational; it is
   *  used only when present). */
  private decodeCertificate(raw: string): string {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return raw;
    }
    try {
      return decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
  }
}
