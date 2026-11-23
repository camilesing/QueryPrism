// Phase 9 (§64): the guard must strip an optional `Bearer ` prefix from the
// X-QUERYPRISM-TOKEN value (the QueryPrism frontend sends `Bearer <jwt>`), accept a raw
// token, and fall back to Authorization: Bearer. Mocks JwtService + ConfigService
// per §24 (plain object cast, jest.fn infers).
//
// The guard is now DB-authoritative for the current workspace: it loads the
// user row + memberships on every request (so switching workspaces takes
// effect immediately and revoked memberships stop working). The prisma mock
// below returns a non-admin user (id 7) bound to workspace 1.
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const PAYLOAD = { sub: 7, account: 'admin', oid: 1, language: 'zh-CN' };

interface DbUser {
  id: number;
  account: string;
  language: string;
  oid: number;
  status: number;
  userWorkspaces: {
    oid: number;
    weight: number;
    workspace: { archivedAt: Date | null };
  }[];
}

function dbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    id: 7,
    account: 'admin',
    language: 'zh-CN',
    oid: 1,
    status: 1,
    userWorkspaces: [{ oid: 1, weight: 0, workspace: { archivedAt: null } }],
    ...overrides,
  };
}

function makePrisma(row: DbUser | null = dbUser()): PrismaService {
  return {
    user: { findUnique: jest.fn().mockResolvedValue(row) },
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
  } as unknown as PrismaService;
}

function makeContext(
  headers: Record<string, string | undefined>,
  req: { user?: unknown } = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) => headers[name],
        ...req,
      }),
      getResponse: () => ({}),
    }),
    // Phase 11F: JwtAuthGuard now reads @Public() via Reflector. The default
    // reflector mock returns undefined (no @Public) so existing tests exercise
    // the token path; tests that need @Public override getAllAndOverride.
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeGuard(
  verify: jest.Mock,
  reflector: { getAllAndOverride: jest.Mock } = {
    getAllAndOverride: jest.fn().mockReturnValue(undefined),
  },
  prisma: PrismaService = makePrisma(),
): JwtAuthGuard {
  const jwt = { verifyAsync: verify } as unknown as JwtService;
  const config = {
    get: (k: string) =>
      k === 'jwt.tokenKey' ? 'X-QUERYPRISM-TOKEN' : undefined,
  } as unknown as ConfigService;
  return new JwtAuthGuard(
    jwt,
    config,
    reflector as unknown as Reflector,
    prisma,
  );
}

describe('JwtAuthGuard', () => {
  beforeEach(() => {
    // Specs run outside a request scope → tr() resolves to English.
    setI18n(createTestI18n());
  });

  it('strips the `Bearer ` prefix from X-QUERYPRISM-TOKEN', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(verify);
    await expect(
      guard.canActivate(
        makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer abc.def.ghi' }),
      ),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('abc.def.ghi');
  });

  it('rejects a token without a numeric `sub` (e.g. an assistant JWT) before any lookup', async () => {
    // The assistant JWT is signed with the same secret but carries no `sub`;
    // it used to reach `findUnique({ where: { id: undefined } })` and 500.
    const verify = jest.fn().mockResolvedValue({
      id: 1,
      account: 'queryprism-inner-assistant',
      oid: 1,
      assistant_id: 42,
    });
    const prisma = makePrisma();
    const guard = makeGuard(verify, undefined, prisma);
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer a.b.c' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('accepts a raw token in X-QUERYPRISM-TOKEN (no Bearer prefix)', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(verify);
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'abc.def.ghi' })),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('abc.def.ghi');
  });

  it('falls back to Authorization: Bearer and strips the prefix', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(verify);
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer abc.def.ghi' })),
    ).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('abc.def.ghi');
  });

  it('throws Not signed in when no token header is present', async () => {
    const verify = jest.fn();
    const guard = makeGuard(verify);
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(
      'Not signed in',
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('throws Session expired when verifyAsync rejects', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('bad signature'));
    const guard = makeGuard(verify);
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer bad' })),
    ).rejects.toThrow('Session expired, please sign in again');
  });

  it('attaches the DB user + membership weight to req.user', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(verify);
    const req: {
      user?: unknown;
      header?: (name: string) => string | undefined;
    } = { header: () => 'Bearer abc.def.ghi' };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as unknown as ExecutionContext;
    await guard.canActivate(ctx);
    expect(req.user).toEqual({
      id: 7,
      account: 'admin',
      oid: 1,
      language: 'zh-CN',
      weight: 0,
      iat: undefined,
      exp: undefined,
    });
  });

  it('uses User.oid from the DB instead of the stale JWT oid', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD); // JWT says oid 1
    const guard = makeGuard(
      verify,
      undefined,
      makePrisma(
        dbUser({
          oid: 2,
          userWorkspaces: [
            { oid: 1, weight: 0, workspace: { archivedAt: null } },
            { oid: 2, weight: 1, workspace: { archivedAt: null } },
          ],
        }),
      ),
    );
    const req: {
      user?: { oid: number; weight: number };
      header: (name: string) => string | undefined;
    } = { header: () => 'Bearer abc.def.ghi' };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getHandler: () => () => {},
      getClass: () => class {},
    } as unknown as ExecutionContext;
    await guard.canActivate(ctx);
    expect(req.user?.oid).toBe(2);
    expect(req.user?.weight).toBe(1);
  });

  it('rejects a non-admin with no membership for the current workspace', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(
      verify,
      undefined,
      makePrisma(dbUser({ userWorkspaces: [] })),
    );
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer abc' })),
    ).rejects.toThrow('Current workspace not found or access denied');
  });

  it('rejects a non-admin whose current workspace is archived', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(
      verify,
      undefined,
      makePrisma(
        dbUser({
          userWorkspaces: [
            {
              oid: 1,
              weight: 0,
              workspace: { archivedAt: new Date() },
            },
          ],
        }),
      ),
    );
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer abc' })),
    ).rejects.toThrow('Current workspace has been archived');
  });

  it('rejects a disabled or deleted account', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const guard = makeGuard(
      verify,
      undefined,
      makePrisma(dbUser({ status: 0 })),
    );
    await expect(
      guard.canActivate(makeContext({ 'X-QUERYPRISM-TOKEN': 'Bearer abc' })),
    ).rejects.toThrow('Account not found or disabled');
  });

  it('Phase 11F: @Public() route skips token verification (returns true)', async () => {
    const verify = jest.fn().mockResolvedValue(PAYLOAD);
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true), // @Public() set
    };
    const guard = makeGuard(verify, reflector);
    await expect(guard.canActivate(makeContext({}))).resolves.toBe(true);
    // Token verification MUST NOT run on a public route.
    expect(verify).not.toHaveBeenCalled();
  });
});
