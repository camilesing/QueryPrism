import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Response as ExpressResponse } from 'express';

// Phase 9: the frontend unwraps `data` only when `code === 0`, and reads the
// error/message field as `msg` (the success envelope is `{code, data, msg}`).
// Keep `success: boolean` for backward compatibility with any code reading it,
// but the load-bearing fields are `code`/`data`/`msg`.
export interface Response<T> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

@Injectable()
// The interceptor's output is genuinely a union: the wrapped envelope for
// normal handlers, or the raw data (SSE bypass) when headers were already
// sent. Declaring the union keeps the NestInterceptor contract honest.
export class TransformInterceptor<T = unknown> implements NestInterceptor<
  T,
  Response<T> | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<Response<T> | T> {
    const res = context
      .switchToHttp()
      .getResponse<ExpressResponse | undefined>();
    return next.handle().pipe(
      // SSE handlers (raw @Res() + SseWriter) have already started streaming by
      // the time this map runs; wrapping their void return into the success
      // envelope would be discarded by Nest's non-passthrough @Res() handling,
      // but the guard makes the intent explicit and is robust against any
      // future interceptor that might try to send the body.
      map((data) =>
        res?.headersSent
          ? data
          : { success: true, code: 0, msg: 'success', data },
      ),
    );
  }
}
