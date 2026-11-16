// SystemLogInterceptor spec — §121 gap #1 (Phase 11G cycle 1).
//
// The AssistantTokenGuard's Assistant scheme populates RequestContext.user
// with a VIRTUAL user { id: virtual, account: 'queryprism-inner-assistant', oid },
// which has no User row. The @SystemLog-decorated assistantStart route then
// triggers AuditService.record → prisma.systemLog.create({ operatorId: virtual })
// → FK violation (operatorId → User.id). The interceptor now short-circuits
// (returns next.handle() without audit) when user.account === 'queryprism-inner-
// assistant' — the exact sentinel the guard sets.
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  requestContextStorage,
  type RequestContextData,
} from '../common/context/request-context';
import { AuditService } from './audit.service';
import { SystemLogInterceptor } from './system-log.interceptor';
import type { LogConfig } from './log-config.interface';

const LOG_CONFIG: LogConfig = {
  module: 'chat' as LogConfig['module'],
  type: 'create' as LogConfig['type'],
};

const VIRTUAL_USER: RequestContextData = {
  user: {
    id: 999,
    account: 'queryprism-inner-assistant',
    oid: 1,
    language: 'zh-CN',
  },
};
const NORMAL_USER: RequestContextData = {
  user: { id: 1, account: 'admin', oid: 1, language: 'zh-CN' },
};

function makeCtx(): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () =>
        ({
          headers: {},
          method: 'POST',
          url: '/api/v1/x',
          originalUrl: '/api/v1/x',
          ip: '127.0.0.1',
        }) as never,
    }),
  } as unknown as ExecutionContext;
}

function makeInterceptor(recordFn: jest.Mock, config: LogConfig | undefined) {
  const reflector = { get: jest.fn().mockReturnValue(config) };
  const audit = { record: recordFn } as unknown as AuditService;
  const interceptor = new SystemLogInterceptor(reflector as never, audit);
  return { interceptor, reflector, audit };
}

const next: CallHandler = { handle: () => of('ok') };

describe('SystemLogInterceptor', () => {
  describe('§121 gap #1: skip audit for virtual assistant user', () => {
    it('does NOT call audit.record when user.account is queryprism-inner-assistant', async () => {
      const record = jest.fn();
      const { interceptor } = makeInterceptor(record, LOG_CONFIG);
      await requestContextStorage.run(VIRTUAL_USER, () =>
        lastValueFrom(interceptor.intercept(makeCtx(), next)),
      );
      expect(record).not.toHaveBeenCalled();
    });

    it('calls audit.record for a normal user (regression guard)', async () => {
      const record = jest.fn().mockResolvedValue(undefined);
      const { interceptor } = makeInterceptor(record, LOG_CONFIG);
      await requestContextStorage.run(NORMAL_USER, () =>
        lastValueFrom(interceptor.intercept(makeCtx(), next)),
      );
      expect(record).toHaveBeenCalledTimes(1);
      // §25 exact-literal on the deterministic fields (executionTime is dynamic
      // → use toMatchObject for the static contract, not expect.any).
      expect(record.mock.calls[0][0]).toMatchObject({
        module: LOG_CONFIG.module,
        type: LOG_CONFIG.type,
        status: 'success',
        oid: 1,
        requestMethod: 'POST',
        requestPath: '/api/v1/x',
      });
    });

    it('no-ops (no audit.record) when handler has no @SystemLog metadata', async () => {
      const record = jest.fn();
      const { interceptor } = makeInterceptor(record, undefined);
      await requestContextStorage.run(NORMAL_USER, () =>
        lastValueFrom(interceptor.intercept(makeCtx(), next)),
      );
      expect(record).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Appended coverage for the remaining interceptor branches: request capture
// (x-forwarded-for / ip / user-agent / url fallbacks), missing user, envelope
// unwrapping with resources/markFailWhen, the error tap, and a request-object
// absence. Append-only: the tests above stay untouched.
// ---------------------------------------------------------------------------

/** A ctx whose HTTP request is fully controllable (or absent). */
function makeCtxWithRequest(req: unknown): ExecutionContext {
  return {
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const AUDITED: LogConfig = {
  module: 'chat' as LogConfig['module'],
  type: 'create' as LogConfig['type'],
};

describe('SystemLogInterceptor request capture', () => {
  async function recordedFields(
    req: unknown,
  ): Promise<Record<string, unknown>> {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(interceptor.intercept(makeCtxWithRequest(req), next)),
    );
    expect(record).toHaveBeenCalledTimes(1);
    return record.mock.calls[0][0] as Record<string, unknown>;
  }

  it('takes the FIRST x-forwarded-for entry (trimmed)', async () => {
    const entry = await recordedFields({
      headers: { 'x-forwarded-for': '1.1.1.1 , 2.2.2.2' },
      method: 'GET',
      url: '/x',
      ip: '10.0.0.1',
    });
    expect(entry.ipAddress).toBe('1.1.1.1');
  });

  it('ignores a non-string x-forwarded-for and falls back to req.ip', async () => {
    const entry = await recordedFields({
      headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] },
      method: 'GET',
      url: '/x',
      ip: '10.0.0.1',
    });
    expect(entry.ipAddress).toBe('10.0.0.1');
  });

  it('uses req.ip when no forwarding header exists', async () => {
    const entry = await recordedFields({
      headers: {},
      method: 'GET',
      url: '/x',
      ip: '192.168.0.9',
    });
    expect(entry.ipAddress).toBe('192.168.0.9');
  });

  it('records a null ip when neither forwarded header nor req.ip exists', async () => {
    const entry = await recordedFields({
      headers: {},
      method: 'GET',
      url: '/x',
    });
    expect(entry.ipAddress).toBeNull();
  });

  it('captures a string user-agent', async () => {
    const entry = await recordedFields({
      headers: { 'user-agent': 'Mozilla/5.0 qp-test' },
      method: 'GET',
      url: '/x',
    });
    expect(entry.userAgent).toBe('Mozilla/5.0 qp-test');
  });

  it('records a null user-agent for non-string or empty values', async () => {
    const arrayUa = await recordedFields({
      headers: { 'user-agent': ['a'] },
      method: 'GET',
      url: '/x',
    });
    expect(arrayUa.userAgent).toBeNull();
    const emptyUa = await recordedFields({
      headers: { 'user-agent': '' },
      method: 'GET',
      url: '/x',
    });
    expect(emptyUa.userAgent).toBeNull();
  });

  it('prefers originalUrl but falls back to url when it is empty', async () => {
    const withOriginal = await recordedFields({
      headers: {},
      method: 'POST',
      url: '/fallback',
      originalUrl: '/api/v1/real?qp=1',
    });
    expect(withOriginal.requestPath).toBe('/api/v1/real?qp=1');
    const withoutOriginal = await recordedFields({
      headers: {},
      method: 'POST',
      url: '/fallback',
      originalUrl: '',
    });
    expect(withoutOriginal.requestPath).toBe('/fallback');
  });

  it('records the HTTP method verbatim', async () => {
    const entry = await recordedFields({
      headers: {},
      method: 'DELETE',
      url: '/x',
    });
    expect(entry.requestMethod).toBe('DELETE');
  });
});

describe('SystemLogInterceptor request capture absence', () => {
  it('records null capture fields when the request object is missing', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(interceptor.intercept(makeCtxWithRequest(undefined), next)),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      ipAddress: null,
      userAgent: null,
      requestMethod: null,
      requestPath: null,
    });
  });
});

describe('SystemLogInterceptor without a user', () => {
  it('still audits with oid null when the context store has no user', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await requestContextStorage.run({}, () =>
      lastValueFrom(interceptor.intercept(makeCtx(), next)),
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].oid).toBeNull();
    expect(record.mock.calls[0][0].status).toBe('success');
  });

  it('still audits with oid null outside any request scope', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await lastValueFrom(interceptor.intercept(makeCtx(), next));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].oid).toBeNull();
  });
});

describe('SystemLogInterceptor envelope unwrapping', () => {
  const ENVELOPE = {
    success: true,
    code: 0,
    msg: 'success',
    data: { id: 7 },
  };

  it('passes the UNWRAPPED data to resources() and markFailWhen()', async () => {
    const resources = jest.fn(() => [{ name: 'res-7' }]);
    const markFailWhen = jest.fn(() => false);
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, {
      ...AUDITED,
      resources,
      markFailWhen,
    });
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(
        interceptor.intercept(makeCtx(), { handle: () => of(ENVELOPE) }),
      ),
    );
    expect(resources).toHaveBeenCalledWith({ id: 7 });
    expect(markFailWhen).toHaveBeenCalledWith({ id: 7 });
    expect(record.mock.calls[0][0]).toMatchObject({
      status: 'success',
      resources: [{ name: 'res-7' }],
    });
  });

  it('marks a success-side failure via markFailWhen with errorMessage null', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, {
      ...AUDITED,
      markFailWhen: () => true,
    });
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(
        interceptor.intercept(makeCtx(), { handle: () => of(ENVELOPE) }),
      ),
    );
    expect(record.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      errorMessage: null,
    });
  });

  it('does not unwrap a result missing the data key', async () => {
    const resources = jest.fn(() => []);
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, { ...AUDITED, resources });
    const partial = { success: true };
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(
        interceptor.intercept(makeCtx(), { handle: () => of(partial) }),
      ),
    );
    expect(resources).toHaveBeenCalledWith(partial);
  });

  it('defaults resources to [] when no extractor is configured', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(interceptor.intercept(makeCtx(), next)),
    );
    expect(record.mock.calls[0][0].resources).toEqual([]);
  });

  it('handles a null result (no envelope access, no extractor crash)', async () => {
    const resources = jest.fn(() => []);
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, { ...AUDITED, resources });
    await requestContextStorage.run(NORMAL_USER, () =>
      lastValueFrom(
        interceptor.intercept(makeCtx(), { handle: () => of(null) }),
      ),
    );
    expect(resources).toHaveBeenCalledWith(null);
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'success' });
  });
});

describe('SystemLogInterceptor error branch', () => {
  function runFailing(
    config: LogConfig,
    error: unknown,
  ): Promise<Record<string, unknown>> {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, config);
    return requestContextStorage.run(NORMAL_USER, async () => {
      await expect(
        lastValueFrom(
          interceptor.intercept(makeCtx(), {
            handle: () => throwError(() => error),
          }),
        ),
      ).rejects.toBe(error);
      expect(record).toHaveBeenCalledTimes(1);
      return record.mock.calls[0][0] as Record<string, unknown>;
    });
  }

  it('records failed with detail kept and the error message', async () => {
    const entry = await runFailing(
      { ...AUDITED, detail: 'custom detail' },
      new Error('boom'),
    );
    expect(entry).toMatchObject({
      status: 'failed',
      detail: 'custom detail',
      errorMessage: 'boom',
      resources: [],
    });
  });

  it('falls back to the error message for detail when unset', async () => {
    const entry = await runFailing(AUDITED, new Error('boom'));
    expect(entry.detail).toBe('boom');
    expect(entry.errorMessage).toBe('boom');
  });

  it('stringifies a non-Error thrown value', async () => {
    const entry = await runFailing(AUDITED, 'plain failure');
    expect(entry.errorMessage).toBe('plain failure');
    expect(entry.detail).toBeUndefined();
  });

  it('records execution time and capture fields on failure too', async () => {
    const entry = await runFailing(AUDITED, new Error('boom'));
    expect(typeof entry.executionTime).toBe('number');
    expect(entry.executionTime).toBeGreaterThanOrEqual(0);
    expect(entry).toMatchObject({
      oid: 1,
      requestMethod: 'POST',
      requestPath: '/api/v1/x',
    });
  });

  it('records null capture fields on failure when the request is missing', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const { interceptor } = makeInterceptor(record, AUDITED);
    await requestContextStorage.run(NORMAL_USER, async () => {
      await expect(
        lastValueFrom(
          interceptor.intercept(makeCtxWithRequest(undefined), {
            handle: () => throwError(() => new Error('boom')),
          }),
        ),
      ).rejects.toThrow('boom');
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      ipAddress: null,
      userAgent: null,
      requestMethod: null,
      requestPath: null,
    });
  });
});
