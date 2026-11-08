// auth.service spec — need_change_pwd on login and the
// pre-login POST /login/change-pwd flow. Follows the appearance.service.spec
// convention (Test.createTestingModule + a hand-rolled PrismaService mock).
// bcryptjs is jest.mock'ed with compare:(plain,hash)=>plain===hash so a
// "hashed" password is simply the plaintext (the forced-change branch then
// reduces to user.password === DEFAULT_PWD), and hashSync is a constant stub
// so the update assertion is deterministic.
jest.mock('bcryptjs', () => ({
  compare: jest.fn((plain: string, hash: string) =>
    Promise.resolve(plain === hash),
  ),
  hashSync: jest.fn(() => 'hashed-new-pwd'),
  hash: jest.fn((plain: string) => Promise.resolve(`hashed-${plain}`)),
}));

import { Test } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from './auth.service';
import { DEFAULT_PWD } from '../user/user.service';

// A complete-enough User row for the paths under test.
const baseUser = {
  id: 5,
  account: 'demo',
  email: null,
  oid: 1,
  status: 1,
  origin: 0,
  language: 'zh-CN',
  password: 'Ir0nM@nPwd',
};

describe('AuthService (#1355 initial-password policy)', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    userWs: { findUnique: jest.Mock };
    systemVariable: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      // Non-admin logins now require an active membership for User.oid.
      userWs: {
        findUnique: jest.fn().mockResolvedValue({
          workspace: { archivedAt: null },
        }),
      },
      systemVariable: { findFirst: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('jwt-token') },
        },
        // AuthService only touches ConfigService inside encryptSecret (not
        // exercised here); an empty object satisfies the constructor.
        { provide: ConfigService, useValue: {} },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('login → need_change_pwd', () => {
    it('issues a token with need_change_pwd=false when the flag is off', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser });
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      const res = await service.login('demo', 'Ir0nM@nPwd');
      expect(res.needChangePwd).toBe(false);
      expect(res.token).toBe('jwt-token');
    });

    it('returns an empty token + need_change_pwd=true when a non-admin user still has the initial password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue({
        name: 'login.initial_pwd_disabled',
        value: 'true',
      });
      const res = await service.login('demo', DEFAULT_PWD);
      expect(res.needChangePwd).toBe(true);
      expect(res.token).toBe('');
    });

    it('exempts uid=1 (admin) from the forced change', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        id: 1,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue({
        name: 'login.initial_pwd_disabled',
        value: 'true',
      });
      const res = await service.login('demo', DEFAULT_PWD);
      expect(res.needChangePwd).toBe(false);
      expect(res.token).toBe('jwt-token');
    });

    it('issues a token when the flag is on but the password is no longer the initial one', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser });
      prisma.systemVariable.findFirst.mockResolvedValue({
        name: 'login.initial_pwd_disabled',
        value: 'true',
      });
      const res = await service.login('demo', 'Ir0nM@nPwd');
      expect(res.needChangePwd).toBe(false);
      expect(res.token).toBe('jwt-token');
    });

    it('treats a non-true pval (e.g. "false") as flag-off', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue({
        name: 'login.initial_pwd_disabled',
        value: 'false',
      });
      const res = await service.login('demo', DEFAULT_PWD);
      expect(res.needChangePwd).toBe(false);
    });
  });

  describe('changePwd', () => {
    it('re-hashes and stores the new password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      await expect(
        service.changePwd('demo', DEFAULT_PWD, 'NewP@ssw0rd'),
      ).resolves.toEqual({ success: true });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: baseUser.id },
        data: { password: 'hashed-new-pwd' },
      });
    });

    it('rejects a wrong old password', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser });
      await expect(
        service.changePwd('demo', 'Wr0ngP@ss', 'NewP@ssw0rd'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a non-local (origin≠0) account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        origin: 3,
      });
      await expect(
        service.changePwd('demo', 'Ir0nM@nPwd', 'NewP@ssw0rd'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a weak new password (format check)', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser });
      await expect(
        service.changePwd('demo', 'Ir0nM@nPwd', 'weakpassword'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects the initial password as the new one while the flag is on', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue({
        name: 'login.initial_pwd_disabled',
        value: 'true',
      });
      await expect(
        service.changePwd('demo', DEFAULT_PWD, DEFAULT_PWD),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // DEFAULT_PWD is '123456', which never satisfies
    // PWD_REGEX — so with the flag OFF, re-using the initial password as the
    // new one is still rejected by the format check.
    it('still rejects the initial password as the new one when the flag is off (format check)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        password: DEFAULT_PWD,
      });
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      await expect(
        service.changePwd('demo', DEFAULT_PWD, DEFAULT_PWD),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
