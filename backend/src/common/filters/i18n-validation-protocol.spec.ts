// Verifies the plain-text error protocol survives the I18nValidationPipe:
// the filter joins class-validator messages into ONE string body — the pipe
// must produce string messages (not objects), or `error.response.data` would
// render as [object Object] in the frontend handleError.
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { I18nValidationPipe } from 'nestjs-i18n';
import { HttpExceptionFilter } from './http-exception.filter';

class SampleDto {
  @IsIn(['en', 'zh-CN'])
  language!: string;
}

describe('I18nValidationPipe ↔ HttpExceptionFilter protocol', () => {
  const pipe = new I18nValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta = { type: 'body', metatype: SampleDto, data: '' };

  const filterBody = (exception: HttpException): string => {
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
    new HttpExceptionFilter().catch(exception, host);
    return res.send.mock.calls[0][0] as string;
  };

  it('produces string validation messages joined into a plain-text body', async () => {
    let thrown: unknown;
    // A string outside the set fails @IsIn regardless of implicit conversion.
    await pipe
      .transform({ language: 'fr' }, meta as never)
      .catch((e: unknown) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(HttpException);
    const body = filterBody(thrown as HttpException);
    expect(typeof body).toBe('string');
    expect(body).not.toContain('[object Object]');
    // The constraint string (untranslated in a unit test; localized in-app)
    // must survive into the body — not the bare "Bad Request".
    expect(body).toMatch(/language must be one of the following values/);
  });
});
