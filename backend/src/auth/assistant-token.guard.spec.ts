// AssistantTokenGuard spec — TDD red for Phase 11F.
//
// Verifies the two assistant-token schemes:
//  - `Assistant <jwt>` (type 0/1): verify with global jwt.secret; load assistant
//    by assistant_id claim; populate RequestContext.user with {id:payload.id,
//    account:'queryprism-inner-assistant', oid:payload.oid} + RequestContext.assistant.
//  - `Embedded <jwt>` (type 4): two-pass — unverified decode → embeddedId (or
//    xor_decrypt(app_id)) → load assistant → verify with decryptAppSecret
//    (assistant.appSecret) → load user by `account` claim → populate
//    RequestContext.user with the user's oid.
//
// Header enrichment: X-QUERYPRISM-ASSISTANT-CERTIFICATE (base64 +
// URL-decode), X-QUERYPRISM-ASSISTANT-ONLINE (str→bool), X-QUERYPRISM-HOST-ORIGIN.
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AssistantTokenGuard } from './assistant-token.guard';
import { AssistantService } from '../assistant/assistant.service';
import { PrismaService } from '../database/prisma.service';
import {
  requestContextStorage,
  type RequestContextData,
} from '../common/context/request-context';

function makeContext(headers: Record<string, string | undefined>): {
  ctx: ExecutionContext;
  req: { user?: unknown; header: (name: string) => string | undefined };
} {
  // getRequest must return the SAME object so the guard's `req.user = ...`
  // mutation is observable by the test (mirrors jwt-auth.guard.spec pattern).
  const req: { user?: unknown; header: (name: string) => string | undefined } =
    {
      header: (name: string) => headers[name.toLowerCase()],
    };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
    getHandler: () => () => {},
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function makeGuard() {
  const jwtService = {
    verifyAsync: jest.fn(),
    decode: jest.fn(),
    signAsync: jest.fn(),
  };
  const config = {
    get: jest.fn((k: string) => {
      if (k === 'jwt.secret') return 'jwt-secret';
      if (k === 'aes.key') return 'aes-key';
      return undefined;
    }),
  };
  const assistantService = {
    decryptAppSecret: jest.fn(),
  };
  const prisma = {
    assistant: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    // Embedded scheme: the asserted account's membership of the assistant's
    // workspace. A member by default; tests narrow it with mockResolvedValue.
    userWs: { findFirst: jest.fn().mockResolvedValue({ oid: 1 }) },
  };
  const guard = new AssistantTokenGuard(
    jwtService as unknown as JwtService,
    config as unknown as ConfigService,
    assistantService as unknown as AssistantService,
    prisma as unknown as PrismaService,
  );
  return { guard, jwtService, config, assistantService, prisma };
}

async function runInCtx<T>(fn: () => Promise<T>): Promise<{
  result: T;
  store: RequestContextData;
}> {
  const store: RequestContextData = {};
  let result: T;
  await requestContextStorage.run(store, async () => {
    result = await fn();
  });
  return { result: result!, store };
}

describe('AssistantTokenGuard', () => {
  describe('Assistant scheme (type 0/1)', () => {
    it('valid `Assistant <jwt>` → populates req.user + RequestContext.assistant', async () => {
      const m = makeGuard();
      const payload = {
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      };
      m.jwtService.verifyAsync.mockResolvedValue(payload);
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 0,
        domain: 'https://embed.example.com',
        appId: 'uuid-42',
        configuration: null,
        appSecret: 'encrypted',
      });

      const { ctx, req } = makeContext({
        'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      });

      const { store } = await runInCtx(async () => m.guard.canActivate(ctx));

      expect(m.jwtService.verifyAsync).toHaveBeenCalledWith('fake.jwt.token', {
        secret: 'jwt-secret',
      });
      expect(m.prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 42, status: 'active' },
      });
      // req.user populated with the virtual user shape
      expect(req.user).toEqual({
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        language: 'zh-CN',
      });
      // RequestContext.assistant populated with the assistant header
      expect(store.assistant).toMatchObject({
        id: 42,
        oid: 1,
        type: 0,
        domain: 'https://embed.example.com',
        appId: 'uuid-42',
      });
    });

    it('certificate/online/host-origin headers enrich RequestContext.assistant', async () => {
      const m = makeGuard();
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 0,
        domain: 'https://embed.example.com',
        appId: 'uuid-42',
        configuration: null,
        appSecret: 'encrypted',
      });
      // base64 + URL-decoded certificate: for the spec, use a plain
      // base64 string.
      const certB64 = Buffer.from('hello-certificate').toString('base64');

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
        'x-queryprism-assistant-certificate': certB64,
        'x-queryprism-assistant-online': 'true',
        'x-queryprism-host-origin': 'https://embed.example.com',
      });

      const { store } = await runInCtx(async () => m.guard.canActivate(ctx));

      expect(store.assistant).toMatchObject({
        certificate: 'hello-certificate',
        online: true,
        requestOrigin: 'https://embed.example.com',
      });
    });

    it('assistant not found → throws 401', async () => {
      const m = makeGuard();
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 999,
        account: 'queryprism-inner-assistant',
        oid: 1,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue(null);

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      });

      await expect(
        runInCtx(async () => m.guard.canActivate(ctx)),
      ).rejects.toThrow();
    });
  });

  describe('Embedded scheme (type 4)', () => {
    it('valid `Embedded <jwt>` → populates req.user with USER oid + assistant', async () => {
      const m = makeGuard();
      // First pass: unverified decode returns {id: 42} (the embeddedId).
      m.jwtService.decode.mockReturnValue({ id: 42 });
      // Second pass: verifyAsync with the decrypted appSecret returns the
      // user-bearing payload.
      m.assistantService.decryptAppSecret.mockReturnValue(
        'plaintext-app-secret',
      );
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 42,
        account: 'admin',
        oid: 1,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 4,
        domain: 'https://embed.example.com',
        appId: 'uuid-42',
        configuration: null,
        appSecret: 'encrypted',
      });
      m.prisma.user.findUnique.mockResolvedValue({
        id: 7,
        account: 'admin',
        oid: 5,
        status: 1,
        language: 'en-US',
      });

      const { ctx, req } = makeContext({
        'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
      });

      const { store } = await runInCtx(async () => m.guard.canActivate(ctx));

      // First-pass decode (no secret).
      expect(m.jwtService.decode).toHaveBeenCalledWith('fake.jwt.token');
      // Assistant loaded by embeddedId.
      expect(m.prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 42, status: 'active' },
      });
      // appSecret decrypted.
      expect(m.assistantService.decryptAppSecret).toHaveBeenCalledWith(
        'encrypted',
      );
      // Second-pass verify with the decrypted secret.
      expect(m.jwtService.verifyAsync).toHaveBeenCalledWith('fake.jwt.token', {
        secret: 'plaintext-app-secret',
      });
      // User loaded by account claim.
      expect(m.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { account: 'admin' },
      });
      // ...and must be a member of the assistant's own workspace (oid 1).
      expect(m.prisma.userWs.findFirst).toHaveBeenCalledWith({
        where: { uid: 7, oid: 1 },
        select: { oid: true },
      });
      // req.user uses the USER's oid (5), not the assistant's oid (1).
      expect(req.user).toEqual({
        id: 7,
        account: 'admin',
        oid: 5,
        language: 'en-US',
      });
      expect(store.assistant).toMatchObject({
        id: 42,
        type: 4,
        appId: 'uuid-42',
      });
    });

    it('rejects an asserted account from another workspace: an app secret must not impersonate other tenants', async () => {
      const m = makeGuard();
      m.jwtService.decode.mockReturnValue({ id: 42 });
      m.assistantService.decryptAppSecret.mockReturnValue(
        'plaintext-app-secret',
      );
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 42,
        account: 'alice',
        oid: 9,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1, // the app belongs to workspace 1 …
        type: 4,
        domain: 'https://embed.example.com',
        appId: 'uuid-42',
        configuration: null,
        appSecret: 'encrypted',
      });
      m.prisma.user.findUnique.mockResolvedValue({
        id: 7,
        account: 'alice',
        oid: 9, // … while alice only belongs to workspace 9
        status: 1,
        language: 'en-US',
      });
      m.prisma.userWs.findFirst.mockResolvedValue(null);

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
      });
      await expect(
        runInCtx(async () => m.guard.canActivate(ctx)),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('falls back to xor_decrypt(app_id) when unverified decode has no id', async () => {
      const m = makeGuard();
      // First pass: no `id` claim, but has `app_id`.
      m.jwtService.decode.mockReturnValue({ app_id: 'a-p-b64' });
      m.assistantService.decryptAppSecret.mockReturnValue('plaintext-secret');
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 42,
        account: 'admin',
        oid: 1,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 4,
        appId: 'uuid-42',
        appSecret: 'encrypted',
        domain: null,
        configuration: null,
      });
      m.prisma.user.findUnique.mockResolvedValue({
        id: 7,
        account: 'admin',
        oid: 5,
        status: 1,
        language: 'en-US',
      });

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
      });

      await runInCtx(async () => m.guard.canActivate(ctx));

      // xor_decrypt was applied to app_id 'a-p-b64' to derive the embeddedId.
      // The assistant was looked up by the derived id (not the missing claim).
      const call = m.prisma.assistant.findFirst.mock.calls[0][0];
      expect(call.where.id).toBeGreaterThan(0); // derived from XOR
      expect(call.where.id).not.toBe(42); // not the literal claim (which was absent)
    });

    it('non-type-4 assistant (e.g. API app) is rejected (bbfc4cc8)', async () => {
      const m = makeGuard();
      m.jwtService.decode.mockReturnValue({ id: 42 });
      m.assistantService.decryptAppSecret.mockReturnValue('secret');
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 3, // NOT the embedded (type 4) app kind
        appId: 'uuid-42',
        appSecret: 'encrypted',
        domain: null,
        configuration: null,
      });

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
      });

      let caught: unknown;
      try {
        await runInCtx(async () => m.guard.canActivate(ctx));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
      // Rejected BEFORE the app_secret verify (no secret check needed).
      expect(m.jwtService.verifyAsync).not.toHaveBeenCalled();
    });

    it('admin account is rejected for embedded tokens (bbfc4cc8)', async () => {
      const m = makeGuard();
      m.jwtService.decode.mockReturnValue({ id: 42 });
      m.assistantService.decryptAppSecret.mockReturnValue('secret');
      m.jwtService.verifyAsync.mockResolvedValue({
        id: 42,
        account: 'admin',
        oid: 1,
        assistant_id: 42,
      });
      m.prisma.assistant.findFirst.mockResolvedValue({
        id: 42,
        oid: 1,
        type: 4,
        appId: 'uuid-42',
        appSecret: 'encrypted',
        domain: null,
        configuration: null,
      });
      // Admin check: uid 1 + account 'admin'.
      m.prisma.user.findUnique.mockResolvedValue({
        id: 1,
        account: 'admin',
        oid: 1,
        status: 1,
        language: 'zh-CN',
      });

      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
      });

      let caught: unknown;
      try {
        await runInCtx(async () => m.guard.canActivate(ctx));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('failure modes', () => {
    it('missing token header → throws', async () => {
      const m = makeGuard();
      const { ctx } = makeContext({});
      await expect(
        runInCtx(async () => m.guard.canActivate(ctx)),
      ).rejects.toThrow();
    });

    it('invalid signature → throws', async () => {
      const m = makeGuard();
      m.jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));
      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      });
      await expect(
        runInCtx(async () => m.guard.canActivate(ctx)),
      ).rejects.toThrow();
    });

    it('unknown scheme → throws', async () => {
      const m = makeGuard();
      const { ctx } = makeContext({
        'x-queryprism-assistant-token': 'Bearer fake.jwt.token',
      });
      await expect(
        runInCtx(async () => m.guard.canActivate(ctx)),
      ).rejects.toThrow();
    });
  });
});

describe('AssistantTokenGuard residual arms', () => {
  const assistantRow = {
    id: 42,
    oid: 1,
    type: 4,
    appId: 'uuid-42',
    appSecret: 'encrypted',
    domain: null,
    configuration: null,
  };
  const activeUser = {
    id: 7,
    account: 'member',
    oid: 5,
    status: 1,
    language: 'en-US',
  };

  it('rejects a header with no scheme separator', async () => {
    const m = makeGuard();
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Assistant',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
  });

  it('rejects a header whose token part is empty (trailing space)', async () => {
    const m = makeGuard();
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded ',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
  });

  it('Assistant scheme: token without assistant_id claim is rejected', async () => {
    const m = makeGuard();
    m.jwtService.verifyAsync.mockResolvedValue({
      id: 9,
      account: 'a',
      oid: 1,
    });
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
    expect(m.prisma.assistant.findFirst).not.toHaveBeenCalled();
  });

  it('Assistant scheme: null id claim maps to virtual user id 0', async () => {
    const m = makeGuard();
    m.jwtService.verifyAsync.mockResolvedValue({
      id: null,
      account: 'queryprism-inner-assistant',
      oid: 3,
      assistant_id: 42,
    });
    m.prisma.assistant.findFirst.mockResolvedValue({
      ...assistantRow,
      type: 0,
    });
    const { ctx, req } = makeContext({
      'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
    });
    const { store } = await runInCtx(async () => m.guard.canActivate(ctx));
    expect(req.user).toMatchObject({ id: 0, oid: 3 });
    expect(store.assistant).toMatchObject({ id: 42 });
  });

  it('Embedded: undecodable token is rejected', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue(null);
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
  });

  it('Embedded: no id claim and no app_id → rejected before lookup', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ account: 'member' });
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
    expect(m.prisma.assistant.findFirst).not.toHaveBeenCalled();
  });

  it('Embedded: unknown assistant id is rejected', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.invalid_origin');
  });

  it('Embedded: second-pass signature failure is token_expired', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(assistantRow);
    m.assistantService.decryptAppSecret.mockReturnValue('secret');
    m.jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.token_expired');
  });

  it('Embedded: verified payload without account claim is rejected', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(assistantRow);
    m.assistantService.decryptAppSecret.mockReturnValue('secret');
    m.jwtService.verifyAsync.mockResolvedValue({ id: 42 });
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.not_logged_in');
    expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('Embedded: unknown account in payload is rejected', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(assistantRow);
    m.assistantService.decryptAppSecret.mockReturnValue('secret');
    m.jwtService.verifyAsync.mockResolvedValue({ id: 42, account: 'ghost' });
    m.prisma.user.findUnique.mockResolvedValue(null);
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.account_missing_or_disabled');
  });

  it('Embedded: disabled account (status=0) is rejected', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(assistantRow);
    m.assistantService.decryptAppSecret.mockReturnValue('secret');
    m.jwtService.verifyAsync.mockResolvedValue({ id: 42, account: 'member' });
    m.prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: 0 });
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    await expect(
      runInCtx(async () => m.guard.canActivate(ctx)),
    ).rejects.toThrow('auth.account_missing_or_disabled');
  });

  it('online header "1" is true and any other value is false', async () => {
    const m = makeGuard();
    m.jwtService.verifyAsync.mockResolvedValue({
      id: 999,
      account: 'queryprism-inner-assistant',
      oid: 1,
      assistant_id: 42,
    });
    m.prisma.assistant.findFirst.mockResolvedValue({
      ...assistantRow,
      type: 0,
    });
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      'x-queryprism-assistant-online': '1',
    });
    const { store } = await runInCtx(async () => m.guard.canActivate(ctx));
    expect(store.assistant?.online).toBe(true);

    const m2 = makeGuard();
    m2.jwtService.verifyAsync.mockResolvedValue({
      id: 999,
      account: 'queryprism-inner-assistant',
      oid: 1,
      assistant_id: 42,
    });
    m2.prisma.assistant.findFirst.mockResolvedValue({
      ...assistantRow,
      type: 0,
    });
    const { ctx: ctx2 } = makeContext({
      'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      'x-queryprism-assistant-online': 'yes',
    });
    const { store: store2 } = await runInCtx(async () =>
      m2.guard.canActivate(ctx2),
    );
    expect(store2.assistant?.online).toBe(false);
  });

  it('a malformed URL-escape certificate falls back to the base64-decoded text', async () => {
    const m = makeGuard();
    m.jwtService.verifyAsync.mockResolvedValue({
      id: 999,
      account: 'queryprism-inner-assistant',
      oid: 1,
      assistant_id: 42,
    });
    m.prisma.assistant.findFirst.mockResolvedValue({
      ...assistantRow,
      type: 0,
    });
    const certB64 = Buffer.from('100%-not-an-escape', 'utf8').toString(
      'base64',
    );
    const { ctx } = makeContext({
      'x-queryprism-assistant-token': 'Assistant fake.jwt.token',
      'x-queryprism-assistant-certificate': certB64,
    });
    const { store } = await runInCtx(async () => m.guard.canActivate(ctx));
    expect(store.assistant?.certificate).toBe('100%-not-an-escape');
  });

  it('populates req.user even without a running ALS store', async () => {
    const m = makeGuard();
    m.jwtService.decode.mockReturnValue({ id: 42 });
    m.prisma.assistant.findFirst.mockResolvedValue(assistantRow);
    m.assistantService.decryptAppSecret.mockReturnValue('secret');
    m.jwtService.verifyAsync.mockResolvedValue({
      id: 42,
      account: 'member',
    });
    m.prisma.user.findUnique.mockResolvedValue(activeUser);
    const { ctx, req } = makeContext({
      'x-queryprism-assistant-token': 'Embedded fake.jwt.token',
    });
    // no requestContextStorage.run wrapper — the guard must not crash
    await expect(m.guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({
      id: 7,
      account: 'member',
      oid: 5,
      language: 'en-US',
    });
  });
});
