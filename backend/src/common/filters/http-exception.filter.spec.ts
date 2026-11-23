// HttpExceptionFilter spec — pins the plain-text error protocol: the body is
// ALWAYS a string (the frontend renders `error.response.data.toString()`),
// the status comes from the exception, and each exception shape maps to the
// right message. i18n is wired to the test stub so default messages are real.
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { I18nValidationException } from 'nestjs-i18n';
import { HttpExceptionFilter } from './http-exception.filter';
import { setI18n } from '../i18n/translate';
import { createTestI18n } from '../i18n/test-i18n';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  const run = (exception: unknown): { status: number; body: string } => {
    const res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }),
      getArgByIndex: () => ({}),
      getClass: () => Object,
      getHandler: () => () => {},
      getType: () => 'http',
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getArgs: () => [] as never,
      toArray: () => [] as never,
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledTimes(1);
    return {
      status: res.status.mock.calls[0][0] as number,
      body: res.send.mock.calls[0][0] as string,
    };
  };

  beforeAll(() => {
    setI18n(createTestI18n());
  });

  afterAll(() => {
    setI18n(null);
  });

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  describe('I18nValidationException', () => {
    it('flattens constraint messages, walking nested children', () => {
      const ex = new I18nValidationException([
        { constraints: { isNotEmpty: '名称不能为空' } },
        { children: [{ constraints: { isString: 'must be a string' } }] },
        {}, // no constraints, no children — contributes nothing
      ]);
      expect(run(ex)).toEqual({
        status: 400,
        body: '名称不能为空; must be a string',
      });
    });

    it('falls back to the internal-error message when nothing extracts', () => {
      // default-constructed: errors === undefined → ?? [] arm
      expect(run(new I18nValidationException())).toEqual({
        status: 400,
        body: 'Internal server error',
      });
      // errors present but constraint-less
      expect(run(new I18nValidationException([{ children: [] }]))).toEqual({
        status: 400,
        body: 'Internal server error',
      });
    });
  });

  describe('HttpException', () => {
    it('uses the plain string body as the message', () => {
      expect(run(new HttpException('invalid_origin', 401))).toEqual({
        status: 401,
        body: 'invalid_origin',
      });
    });

    it('joins class-validator message arrays with "; "', () => {
      const ex = new BadRequestException({
        message: ['a is wrong', 'b is wrong'],
      });
      expect(run(ex)).toEqual({ status: 400, body: 'a is wrong; b is wrong' });
    });

    it('uses a string r.message verbatim', () => {
      const ex = new HttpException({ message: 'record not found' }, 404);
      expect(run(ex)).toEqual({ status: 404, body: 'record not found' });
    });

    it('falls back to the internal-error message for object bodies without message', () => {
      expect(run(new HttpException({}, 400))).toEqual({
        status: 400,
        body: 'Internal server error',
      });
    });

    it('falls back when getResponse() is neither string nor object', () => {
      expect(run(new HttpException(123, 400))).toEqual({
        status: 400,
        body: 'Internal server error',
      });
    });
  });

  describe('unknown exceptions', () => {
    it('logs and surfaces the Error message with a 500 status', () => {
      expect(run(new Error('boom'))).toEqual({ status: 500, body: 'boom' });
    });

    it('hides the raw message in production: driver and Prisma errors carry hosts, paths and query details', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const out = run(
          new Error("Can't reach database server at db.internal:5432"),
        );
        expect(out.status).toBe(500);
        expect(out.body).toBe('Internal server error'); // generic + localized
        expect(out.body).not.toContain('db.internal');
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    });

    it('falls back to the internal-error message for non-Error throws', () => {
      expect(run('just a string')).toEqual({
        status: 500,
        body: 'Internal server error',
      });
      expect(run(null)).toEqual({
        status: 500,
        body: 'Internal server error',
      });
    });
  });
});
