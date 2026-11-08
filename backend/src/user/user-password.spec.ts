// Spec for the self-service password change policy (the self-service path
// enforces the same rules as /login/change-pwd).
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { UserService } from './user.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

function makeService(savedFlag: unknown) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 7,
        password: bcrypt.hashSync('OldPass1!', 10),
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    systemVariable: {
      findFirst: jest.fn().mockResolvedValue(savedFlag),
    },
  };
  const svc = new UserService(
    prisma as never,
    {
      write: jest.fn(),
      resolveDownload: jest.fn(),
      delete: jest.fn(),
    } as never,
  );
  return { svc, prisma, user: { id: 7, account: 'u7', oid: 1 } as never };
}

describe('UserService.changeOwnPassword', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('accepts a conforming new password after verifying the old one', async () => {
    const { svc, prisma, user } = makeService(null);
    await expect(
      svc.changeOwnPassword(user, 'OldPass1!', 'NewPass2@'),
    ).resolves.toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('rejects a wrong old password', async () => {
    const { svc, prisma, user } = makeService(null);
    await expect(
      svc.changeOwnPassword(user, 'Wrong0ld!', 'NewPass2@'),
    ).rejects.toThrow('Original password is incorrect');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a new password that fails PWD_REGEX', async () => {
    const { svc, prisma, user } = makeService(null);
    await expect(
      svc.changeOwnPassword(user, 'OldPass1!', 'weakpassword'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects the initial password as the new one while login.initial_pwd_disabled is on', async () => {
    const { svc, prisma, user } = makeService({ value: 'true' });
    await expect(
      svc.changeOwnPassword(user, 'OldPass1!', '123456'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // TS nuance (mirrors the auth.service.spec note): DEFAULT_PWD is
  // '123456', which never satisfies PWD_REGEX — so with the flag OFF,
  // re-using the initial password is still rejected by the format check.
  it('still rejects the initial password when the policy flag is off (format check)', async () => {
    const { svc, prisma, user } = makeService({ value: 'false' });
    await expect(
      svc.changeOwnPassword(user, 'OldPass1!', '123456'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
