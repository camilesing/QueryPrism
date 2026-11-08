// Request-scoped context via AsyncLocalStorage. Established by
// RequestContextMiddleware on every request, populated by JwtAuthGuard once a
// token is verified, and readable anywhere downstream (services, audit
// interceptor) without threading req.
import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

export interface CurrentUserInfo {
  id: number;
  account: string;
  oid: number; // current workspace (DB User.oid; JWT oid is only a fallback)
  language: string;
  // Workspace role for the CURRENT workspace: UserWs.weight (0 = ordinary
  // member, non-zero = workspace admin). The hardcoded system admin (uid 1)
  // bypasses workspace checks and is surfaced as 0. Optional because the
  // assistant-token paths construct this without a workspace binding.
  weight?: number;
  // Phase 9b: JWT iat/exp, surfaced so /user/info can return the
  // `time`/`exp` the frontend UserStore.info expects. Optional — the MCP
  // withAuth path constructs CurrentUserInfo without them.
  iat?: number;
  exp?: number;
}

/** Runtime header-enriched assistant context (Phase 11F): a per-request view
 *  of the assistant whose token authorized the call, populated by
 *  `AssistantTokenGuard` from the assistant row + the X-QUERYPRISM-ASSISTANT-*
 *  headers (certificate/online/host-origin). NOT persisted — purely runtime. */
export interface AssistantHeader {
  id: number;
  oid: number;
  type: number;
  domain: string | null;
  configuration: unknown;
  appId: string;
  // Header-populated:
  certificate?: string; // base64 + URL-decoded
  online?: boolean; // str→bool
  requestOrigin?: string; // X-QUERYPRISM-HOST-ORIGIN
}

export interface RequestContextData {
  user?: CurrentUserInfo;
  // Phase 11F: the assistant context, populated by AssistantTokenGuard. The
  // index signature already permitted it at runtime; declaring it explicitly
  // gives `currentAssistant()` a typed accessor.
  assistant?: AssistantHeader;
  /** Raw Accept-Language header — i18n fallback when no user is attached
   *  (e.g. login-page requests rejected by guards). */
  acceptLanguage?: string;
  [key: string]: unknown;
}

/** The single storage instance backing request context. */
export const requestContextStorage =
  new AsyncLocalStorage<RequestContextData>();

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const store: RequestContextData = {
      acceptLanguage: req.headers['accept-language'],
    };
    requestContextStorage.run(store, () => next());
  }
}

/**
 * Static accessor used by non-DI call sites (audit interceptor, utilities).
 * Returns undefined outside a request scope.
 */
export class RequestContext {
  static current(): RequestContextData | undefined {
    return requestContextStorage.getStore();
  }

  static getUser(): CurrentUserInfo | undefined {
    return RequestContext.current()?.user;
  }

  static getUserId(): number | undefined {
    return RequestContext.current()?.user?.id;
  }

  /** Phase 11F: the assistant context, populated by AssistantTokenGuard.
   *  Returns undefined outside an assistant-authorized request (e.g. admin
   *  JWT flows). */
  static currentAssistant(): AssistantHeader | undefined {
    return RequestContext.current()?.assistant;
  }
}
