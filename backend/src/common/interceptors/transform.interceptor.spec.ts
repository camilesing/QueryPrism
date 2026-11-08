import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor';

function makeContext(headersSent: boolean): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent }),
      getRequest: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor;

  beforeEach(() => {
    interceptor = new TransformInterceptor();
  });

  it('wraps the return value into the success envelope when headers not sent', (done) => {
    const next: CallHandler = { handle: () => of({ a: 1 }) };
    interceptor.intercept(makeContext(false), next).subscribe((result) => {
      expect(result).toEqual({
        success: true,
        code: 0,
        msg: 'success',
        data: { a: 1 },
      });
      done();
    });
  });

  it('passes the return value through unwrapped when headers already sent (SSE)', (done) => {
    const next: CallHandler = { handle: () => of({ a: 1 }) };
    interceptor.intercept(makeContext(true), next).subscribe((result) => {
      expect(result).toEqual({ a: 1 });
      done();
    });
  });

  it('wraps an undefined (void SSE handler) return when headers not sent', (done) => {
    const next: CallHandler = { handle: () => of(undefined) };
    interceptor.intercept(makeContext(false), next).subscribe((result) => {
      expect(result).toEqual({
        success: true,
        code: 0,
        msg: 'success',
        data: undefined,
      });
      done();
    });
  });
});
