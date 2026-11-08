// AdminGuard unit tests — the guard reads req.user (set by JwtAuthGuard)
// and enforces the hardcoded admin uid 1 (2026-09 review P0-4/P0-5).
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function makeContext(user?: { id: number }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('allows the hardcoded admin (uid 1)', () => {
    expect(guard.canActivate(makeContext({ id: 1 }))).toBe(true);
  });

  it('403s every other uid', () => {
    for (const id of [2, 3, 0, -1, 999999]) {
      expect(() => guard.canActivate(makeContext({ id }))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('403s when req.user is missing (used without JwtAuthGuard)', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
