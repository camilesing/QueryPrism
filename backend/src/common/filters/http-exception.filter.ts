// Global exception filter. Phase 9: the frontend's `handleError` reads
// `error.response.data.toString()` for non-2xx responses — a JSON object body
// would render as `[object Object]`, so errors are emitted as a plain string
// body (the human-readable message). The HTTP status code carries the
// machine-readable signal; the body is for display. class-validator arrays
// are joined into one string.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { I18nValidationException } from 'nestjs-i18n';
import { Response } from 'express';
import { tr } from '../i18n/translate';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = tr('common.internal_error');

    if (exception instanceof I18nValidationException) {
      // I18nValidationPipe throws its own exception whose getResponse() is
      // just "Bad Request" — the localized constraint strings live on
      // `errors`. Flatten them to keep the plain-text protocol.
      status = exception.getStatus();
      const messages: string[] = [];
      const walk = (
        errors: Array<{
          constraints?: Record<string, string>;
          children?: unknown[];
        }>,
      ) => {
        for (const e of errors) {
          if (e.constraints) messages.push(...Object.values(e.constraints));
          if (Array.isArray(e.children) && e.children.length) {
            walk(e.children as typeof errors);
          }
        }
      };
      walk(exception.errors ?? []);
      message = messages.length
        ? messages.join('; ')
        : tr('common.internal_error');
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const r = res as Record<string, any>;
        // class-validator attaches an array of messages; join them.
        if (Array.isArray(r.message)) {
          message = r.message.join('; ');
        } else if (typeof r.message === 'string') {
          message = r.message;
        }
      }
    } else {
      this.logger.error(
        `Unhandled exception: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
      message = (exception as Error)?.message ?? message;
    }

    response.status(status).type('text/plain').send(message);
  }
}
