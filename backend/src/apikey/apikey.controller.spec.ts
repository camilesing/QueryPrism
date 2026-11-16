// ApiKeyController spec — locks the per-user programmatic-key surface. The
// controller is thin: every route is scoped by the JWT user id, and the :id
// path params are coerced from strings. AES/masking logic lives in the
// service spec; here we assert the wiring and the `+id` coercion.
import { ApiKeyController } from './apikey.controller';
import { ApiKeyService } from './apikey.service';

describe('ApiKeyController', () => {
  let apiKeyService: {
    findAll: jest.Mock;
    revealSecret: jest.Mock;
    create: jest.Mock;
    updateStatus: jest.Mock;
    remove: jest.Mock;
  };
  let controller: ApiKeyController;
  const user = { id: 5, account: 'alice', oid: 1 };

  beforeEach(() => {
    apiKeyService = {
      findAll: jest.fn(),
      revealSecret: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      remove: jest.fn(),
    };
    controller = new ApiKeyController(
      apiKeyService as unknown as ApiKeyService,
    );
  });

  it('findAll is scoped to the current user id', async () => {
    apiKeyService.findAll.mockResolvedValue([]);
    await controller.findAll(user as never);
    expect(apiKeyService.findAll).toHaveBeenCalledWith(5);
  });

  it('revealSecret coerces the string id and scopes to the user', async () => {
    const secret = { id: 12, secret_key: 'sk-plain' };
    apiKeyService.revealSecret.mockResolvedValue(secret);
    await expect(controller.revealSecret('12', user as never)).resolves.toEqual(
      secret,
    );
    expect(apiKeyService.revealSecret).toHaveBeenCalledWith(12, 5);
  });

  it('create generates keys for the current user', async () => {
    apiKeyService.create.mockResolvedValue({ id: 13 });
    await expect(controller.create(user as never)).resolves.toEqual({ id: 13 });
    expect(apiKeyService.create).toHaveBeenCalledWith(5);
  });

  it('updateStatus forwards id, owner and the switch boolean', async () => {
    apiKeyService.updateStatus.mockResolvedValue({ success: true });
    await expect(
      controller.updateStatus({ id: 13, status: false }, user as never),
    ).resolves.toEqual({ success: true });
    expect(apiKeyService.updateStatus).toHaveBeenCalledWith(13, 5, false);
  });

  it('remove coerces the string id and scopes to the user', async () => {
    apiKeyService.remove.mockResolvedValue({ success: true });
    await expect(controller.remove('13', user as never)).resolves.toEqual({
      success: true,
    });
    expect(apiKeyService.remove).toHaveBeenCalledWith(13, 5);
  });
});
