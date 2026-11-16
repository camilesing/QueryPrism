// ApiKeyGuard unit tests — the X-QUERYPRISM-APIKEY / X-QUERYPRISM-APISECRET
// machine-to-machine pair: header presence, ApiKey row lookup (miss /
// disabled), the AES-decrypted timing-safe secret compare (decrypt is mocked
// like llm.service.spec), the DB-authoritative user re-read (disabled
// account, uid-1 workspace existence, membership match + archived
// workspace), and the req.user + ALS attachment. ExecutionContext fakes
// follow jwt-auth.guard.spec.
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { decrypt } from '../common/utils/aes';
import { APIKEY_HEADER, APISECRET_HEADER, ApiKeyGuard } from './api-key.guard';
import {
  RequestContext,
  requestContextStorage,
} from '../common/context/request-context';
import type { PrismaService } from '../database/prisma.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

jest.mock('../common/utils/aes', () => ({
  decrypt: jest.fn(() => 'topsecret'),
}));

// The auto-mocked decrypt, re-typed so .mockImplementation is type-checked.
const decryptMock = decrypt as unknown as jest.Mock;

const SECRET = 'topsecret';

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
    account: 'alice',
    language: 'zh-CN',
    oid: 1,
    status: 1,
    userWorkspaces: [{ oid: 1, weight: 0, workspace: { archivedAt: null } }],
    ...overrides,
  };
}

interface ApiKeyRow {
  secretKey: string;
  status: number;
  uid: number;
}

interface ApiKeyPrismaMock {
  apiKey: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  workspace: { findUnique: jest.Mock };
}

function makePrisma(
  key: ApiKeyRow | null = {
    secretKey: 'enc-secret',
    status: 1,
    uid: 7,
  },
  user: DbUser | null = dbUser(),
  workspace: { id: number } | null = { id: 1 },
): ApiKeyPrismaMock {
  return {
    apiKey: { findUnique: jest.fn().mockResolvedValue(key) },
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    workspace: { findUnique: jest.fn().mockResolvedValue(workspace) },
  };
}

function makeContext(
  headers: Record<string, string | undefined>,
  req: { user?: unknown } = {},
): ExecutionContext {
  // Attach the header fn ONTO the passed object so the guard's req.user write
  // is visible to the caller (a spread copy would swallow it).
  const request = Object.assign(req, {
    header: (name: string) => headers[name],
  });
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function makeGuard(prisma: ApiKeyPrismaMock = makePrisma()): ApiKeyGuard {
  const config = {
    get: (k: string) => (k === 'aes.key' ? 'aes-key' : undefined),
  } as unknown as ConfigService;
  return new ApiKeyGuard(prisma as unknown as PrismaService, config);
}

const GOOD_HEADERS = {
  [APIKEY_HEADER]: 'ak-live',
  [APISECRET_HEADER]: SECRET,
};

describe('ApiKeyGuard', () => {
  beforeEach(() => {
    // Specs run outside a request scope → tr() resolves to English.
    setI18n(createTestI18n());
    decryptMock.mockReturnValue(SECRET);
  });

  it('rejects a missing or empty access-key header before any DB read', async () => {
    const prisma = makePrisma();
    const guard = makeGuard(prisma);
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(
      'X-QUERYPRISM-APIKEY and X-QUERYPRISM-APISECRET headers are required',
    );
    await expect(
      guard.canActivate(makeContext({ [APIKEY_HEADER]: '' })),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing secret header', async () => {
    const prisma = makePrisma();
    const guard = makeGuard(prisma);
    await expect(
      guard.canActivate(makeContext({ [APIKEY_HEADER]: 'ak-live' })),
    ).rejects.toThrow(
      'X-QUERYPRISM-APIKEY and X-QUERYPRISM-APISECRET headers are required',
    );
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('looks the row up by access key and rejects unknown keys', async () => {
    const prisma = makePrisma(null);
    const guard = makeGuard(prisma);
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { accessKey: 'ak-live' },
      select: { secretKey: true, status: true, uid: true },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a disabled ApiKey row', async () => {
    const guard = makeGuard(
      makePrisma({ secretKey: 'enc-secret', status: 0, uid: 7 }),
    );
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
  });

  it('rejects when the stored secret cannot be decrypted (wrong aes key)', async () => {
    const prisma = makePrisma();
    const guard = makeGuard(prisma);
    decryptMock.mockImplementation(() => {
      throw new Error('Invalid encrypted payload format');
    });
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
    // the decrypt call itself must use the configured aes key
    expect(decryptMock).toHaveBeenCalledWith('enc-secret', 'aes-key');
  });

  it('rejects a wrong secret of equal length (timing-safe compare fails)', async () => {
    const prisma = makePrisma();
    const guard = makeGuard(prisma);
    await expect(
      guard.canActivate(
        makeContext({
          [APIKEY_HEADER]: 'ak-live',
          [APISECRET_HEADER]: 'topsecreX', // same length, wrong bytes
        }),
      ),
    ).rejects.toThrow('Invalid API key or secret');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret of different length (length check fails)', async () => {
    const guard = makeGuard(makePrisma());
    await expect(
      guard.canActivate(
        makeContext({
          [APIKEY_HEADER]: 'ak-live',
          [APISECRET_HEADER]: 'short',
        }),
      ),
    ).rejects.toThrow('Invalid API key or secret');
  });

  it('accepts a matching secret, re-reads the owner and attaches req.user', async () => {
    const prisma = makePrisma();
    const guard = makeGuard(prisma);
    const req: { user?: unknown } = {};
    await expect(
      guard.canActivate(makeContext(GOOD_HEADERS, req)),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: expect.objectContaining({ id: true, oid: true, status: true }),
    });
    expect(req.user).toEqual({
      id: 7,
      account: 'alice',
      oid: 1,
      language: 'zh-CN',
      weight: 0, // membership weight of the current workspace
    });
  });

  it('carries the matching membership weight (workspace admin)', async () => {
    const guard = makeGuard(
      makePrisma(
        undefined,
        dbUser({
          userWorkspaces: [
            { oid: 1, weight: 1, workspace: { archivedAt: null } },
          ],
        }),
      ),
    );
    const req: { user?: { weight?: number } } = {};
    await guard.canActivate(makeContext(GOOD_HEADERS, req));
    expect(req.user?.weight).toBe(1);
  });

  it('rejects a disabled or missing owner account', async () => {
    const disabled = makeGuard(makePrisma(undefined, dbUser({ status: 0 })));
    await expect(
      disabled.canActivate(makeContext(GOOD_HEADERS)),
    ).rejects.toThrow('Invalid API key or secret');
    const missing = makeGuard(makePrisma(undefined, null));
    await expect(
      missing.canActivate(makeContext(GOOD_HEADERS)),
    ).rejects.toThrow('Invalid API key or secret');
  });

  it('rejects a non-admin with no membership in the current workspace', async () => {
    const guard = makeGuard(
      makePrisma(
        undefined,
        dbUser({
          userWorkspaces: [
            { oid: 2, weight: 0, workspace: { archivedAt: null } }, // other ws
          ],
        }),
      ),
    );
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
  });

  it('rejects a non-admin whose current workspace is archived', async () => {
    const guard = makeGuard(
      makePrisma(
        undefined,
        dbUser({
          userWorkspaces: [
            { oid: 1, weight: 0, workspace: { archivedAt: new Date() } },
          ],
        }),
      ),
    );
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
  });

  it('uid 1 enters any existing workspace without a membership row', async () => {
    const prisma = makePrisma(
      { secretKey: 'enc-secret', status: 1, uid: 1 },
      dbUser({ id: 1, userWorkspaces: [] }),
      { id: 1 },
    );
    const guard = makeGuard(prisma);
    const req: { user?: { id: number; weight: number } } = {};
    await expect(
      guard.canActivate(makeContext(GOOD_HEADERS, req)),
    ).resolves.toBe(true);
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
    expect(req.user).toMatchObject({ id: 1, weight: 0 });
  });

  it('rejects uid 1 when the current workspace no longer exists', async () => {
    const guard = makeGuard(
      makePrisma(
        { secretKey: 'enc-secret', status: 1, uid: 1 },
        dbUser({ id: 1, userWorkspaces: [] }),
        null,
      ),
    );
    await expect(guard.canActivate(makeContext(GOOD_HEADERS))).rejects.toThrow(
      'Invalid API key or secret',
    );
  });

  it('writes the user into the ALS store when a request scope is active', async () => {
    const guard = makeGuard();
    let insideUser: unknown;
    await requestContextStorage.run({}, async () => {
      await expect(guard.canActivate(makeContext(GOOD_HEADERS))).resolves.toBe(
        true,
      );
      insideUser = RequestContext.getUser();
    });
    expect(insideUser).toEqual({
      id: 7,
      account: 'alice',
      oid: 1,
      language: 'zh-CN',
      weight: 0,
    });
    // outside the scope nothing leaks
    expect(RequestContext.getUser()).toBeUndefined();
  });

  it('passes without an ALS store (guard-run standalone) and still sets req.user', async () => {
    const guard = makeGuard();
    const req: { user?: unknown } = {};
    await expect(
      guard.canActivate(makeContext(GOOD_HEADERS, req)),
    ).resolves.toBe(true);
    expect(req.user).toMatchObject({ id: 7, account: 'alice' });
  });
});
