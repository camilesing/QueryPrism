// AuthController spec — locks the /login wire contract. login maps the
// service's internal {token, needChangePwd} to the frontend shape
// {access_token, token_type, platform_info, need_change_pwd}; changePwd and
// logout are straight delegation. Credential checks live in the service spec.
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let authService: {
    login: jest.Mock;
    changePwd: jest.Mock;
    logout: jest.Mock;
  };
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      login: jest.fn(),
      changePwd: jest.fn(),
      logout: jest.fn(),
    };
    controller = new AuthController(authService as unknown as AuthService);
  });

  it('login maps the internal token pair to the frontend snake shape', async () => {
    authService.login.mockResolvedValue({
      token: 'jwt-abc',
      user: { id: 1 },
      needChangePwd: false,
    });

    await expect(
      controller.login({ username: 'admin', password: 'admin' }),
    ).resolves.toEqual({
      access_token: 'jwt-abc',
      token_type: 'bearer',
      platform_info: null,
      need_change_pwd: false,
    });
    expect(authService.login).toHaveBeenCalledWith('admin', 'admin');
  });

  it('login propagates need_change_pwd with an otherwise empty payload', async () => {
    authService.login.mockResolvedValue({
      token: '',
      needChangePwd: true,
    });
    await expect(
      controller.login({ username: 'bob', password: 'init' }),
    ).resolves.toMatchObject({ access_token: '', need_change_pwd: true });
  });

  it('changePwd forwards the triple from the dto', async () => {
    authService.changePwd.mockResolvedValue({ success: true });
    await expect(
      controller.changePwd({ account: 'bob', pwd: 'init', new_pwd: 'n3w' }),
    ).resolves.toEqual({ success: true });
    expect(authService.changePwd).toHaveBeenCalledWith('bob', 'init', 'n3w');
  });

  it('logout delegates to the service', async () => {
    authService.logout.mockResolvedValue({ success: true });
    await expect(controller.logout()).resolves.toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalled();
  });
});
