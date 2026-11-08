// Global interceptor: when a handler carries @SystemLog(config) metadata,
// record an audit entry on success/fail. No-ops otherwise. Registered as an
// APP_INTERCEPTOR after the TransformInterceptor so it sees the wrapped
// envelope — it unwraps before handing the result to the resource extractor.
//
// Phase 10c cycle 3 (§104): extends the recorded row with the audit-read
// contract surface — oid (workspace), ip_address, user_agent, request_method,
// request_path, execution_time (ms), and error_message on the failed branch.
// These power the audit page's columns/filters; the write side captures them
// from the ExecutionContext + RequestContext + the tap's error.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap } from 'rxjs/operators';
import { RequestContext } from '../common/context/request-context';
import { AuditService } from './audit.service';
import { SYSTEMLOG_KEY } from './system-log.decorator';
import type { LogConfig } from './log-config.interface';

function isEnvelope(
  result: unknown,
): result is { success: unknown; data: unknown } {
  return (
    !!result &&
    typeof result === 'object' &&
    'success' in result &&
    'data' in result
  );
}

function unwrap(result: unknown): unknown {
  if (isEnvelope(result)) {
    return result.data;
  }
  return result;
}

/** Extract the audit-capture fields from the Express request. */
function captureRequest(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
  requestMethod: string;
  requestPath: string;
} {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : undefined) ||
    req.ip ||
    null;
  const userAgent =
    (typeof req.headers['user-agent'] === 'string' &&
      req.headers['user-agent']) ||
    null;
  return {
    ipAddress: ip,
    userAgent,
    requestMethod: req.method,
    requestPath: req.originalUrl || req.url,
  };
}

@Injectable()
export class SystemLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const config = this.reflector.get<LogConfig>(
      SYSTEMLOG_KEY,
      ctx.getHandler(),
    );
    if (!config) {
      return next.handle();
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    const captured = req ? captureRequest(req) : null;
    const user = RequestContext.getUser();
    // §121 gap #1 (Phase 11G): skip audit for virtual assistant users. The
    // AssistantTokenGuard's Assistant scheme populates RequestContext.user with
    // { id: virtual, account: 'queryprism-inner-assistant', oid } — no real User
    // row exists for the virtual id, so prisma.systemLog.create({ operatorId:
    // virtual }) would FK-violate (operatorId → User.id). The Embedded scheme
    // loads a real User → operatorId is valid → this skip does not fire.
    if (user?.account === 'queryprism-inner-assistant') {
      return next.handle();
    }
    const oid = user?.oid ?? null;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: (result) => {
          const data = unwrap(result);
          const failed = config.markFailWhen?.(data) ?? false;
          void this.audit.record({
            module: config.module,
            type: config.type,
            status: failed ? 'failed' : 'success',
            detail: config.detail,
            resources: config.resources?.(data) ?? [],
            oid,
            ipAddress: captured?.ipAddress ?? null,
            userAgent: captured?.userAgent ?? null,
            executionTime: Date.now() - start,
            errorMessage: null,
            requestMethod: captured?.requestMethod ?? null,
            requestPath: captured?.requestPath ?? null,
          });
        },
        error: (err: unknown) => {
          void this.audit.record({
            module: config.module,
            type: config.type,
            status: 'failed',
            detail: config.detail ?? (err as Error)?.message,
            resources: [],
            oid,
            ipAddress: captured?.ipAddress ?? null,
            userAgent: captured?.userAgent ?? null,
            executionTime: Date.now() - start,
            errorMessage: (err as Error)?.message ?? String(err),
            requestMethod: captured?.requestMethod ?? null,
            requestPath: captured?.requestPath ?? null,
          });
        },
      }),
    );
  }
}
