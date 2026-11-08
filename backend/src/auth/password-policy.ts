// Shared initial-password policy for the login and self-service
// password-change paths. Both
// AuthService.changePwd (first-login forced change) and
// UserService.changeOwnPassword (PUT /user/pwd) must refuse the default
// initial password as a NEW password while login.initial_pwd_disabled is on.
//
// Reads SystemVariable directly (type='parameter', name=pkey) — the no-DI
// pattern appearance.service/auth.service use; a module import would be
// circular (ParameterModule imports AuthModule).
import { PrismaService } from '../database/prisma.service';
import { jsonValueToString } from '../common/utils/json-value';

/** Password format (PWD_REGEX): 8-20 chars with at
 *  least one lowercase, one uppercase, one digit and one special character.
 *  Enforced server-side on both password-change routes (pre-login and
 *  self-service) — the frontend regex alone is not trustworthy. */
export const PWD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[~!@#$%^&*()_+\-={}|:"<>?`[\];',./])[A-Za-z\d~!@#$%^&*()_+\-={}|:"<>?`[\];',./]{8,20}$/;

/** True when login.initial_pwd_disabled is on (a missing parameter row means
 *  off — the admin parameter page only upserts rows on save). */
export async function initialPwdDisabled(
  prisma: PrismaService,
): Promise<boolean> {
  const row = await prisma.systemVariable.findFirst({
    where: { type: 'parameter', name: 'login.initial_pwd_disabled' },
  });
  if (!row) {
    return false;
  }
  return jsonValueToString(row.value).trim().toLowerCase() === 'true';
}
