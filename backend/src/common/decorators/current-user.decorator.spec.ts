// current-user.decorator spec — the param-decorator factory: req.user wins,
// RequestContext.getUser() (ALS) is the fallback, undefined when neither has a
// user, and `_data` projects a single field. The factory is extracted by
// applying the decorator to a dummy method the same way the TS decorator
// emitter does (param decorators receive the prototype + method name), then
// reading Nest's ROUTE_ARGS_METADATA off the class.
import type { ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentUser } from './current-user.decorator';
import {
  requestContextStorage,
  type CurrentUserInfo,
} from '../context/request-context';

const user: CurrentUserInfo = {
  id: 7,
  account: 'demo',
  oid: 2,
  language: 'zh-CN',
  weight: 0,
};

interface ParamMeta {
  index: number;
  factory: (data: string | undefined, ctx: ExecutionContext) => unknown;
}

/** Apply the param decorator manually (mirrors TS emit for
 *  `handler(@CurrentUser('id') x, @CurrentUser() y)`) and return the
 *  CustomParamFactory captured in the route-args metadata. */
function extractFactories(): Array<
  (data: string | undefined, ctx: ExecutionContext) => unknown
> {
  class Demo {
    handler(first: unknown, second: unknown): void {
      void first;
      void second;
    }
  }
  CurrentUser('id')(Demo.prototype, 'handler', 0);
  CurrentUser(undefined)(Demo.prototype, 'handler', 1);
  const meta = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Demo,
    'handler',
  ) as Record<string, ParamMeta>;
  return Object.values(meta)
    .sort((a, b) => a.index - b.index)
    .map((m) => m.factory);
}

function makeCtx(userOnReq?: CurrentUserInfo): ExecutionContext {
  const req = { user: userOnReq };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('CurrentUser param decorator', () => {
  const [projectField, wholeUser] = extractFactories();

  it('returns req.user when the guard attached it', () => {
    expect(wholeUser(undefined, makeCtx(user))).toEqual(user);
  });

  it('falls back to the ALS RequestContext when req.user is absent', () => {
    requestContextStorage.run({ user }, () => {
      expect(wholeUser(undefined, makeCtx())).toEqual(user);
    });
  });

  it('returns undefined when neither source has a user', () => {
    requestContextStorage.run({}, () => {
      expect(wholeUser(undefined, makeCtx())).toBeUndefined();
      expect(projectField('id', makeCtx())).toBeUndefined();
    });
  });

  it('projects a single field when a property key is passed', () => {
    expect(projectField('id', makeCtx(user))).toBe(7);
    expect(projectField('account', makeCtx(user))).toBe('demo');
  });

  it('req.user wins over the ALS store user', () => {
    const reqUser: CurrentUserInfo = { ...user, id: 99 };
    requestContextStorage.run({ user }, () => {
      expect(projectField('id', makeCtx(reqUser))).toBe(99);
    });
  });
});
