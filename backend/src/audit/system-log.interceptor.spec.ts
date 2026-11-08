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
import { lastValueFrom, of } from 'rxjs';
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
