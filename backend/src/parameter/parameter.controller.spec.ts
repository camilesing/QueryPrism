// ParameterController spec — locks the route → service wiring for the
// reconciled /system/parameter surface. The controller is thin (guards +
// multipart parse + delegation); the service + parseParameterItems carry the
// real logic and are covered by parameter.service.spec. Here we assert the
// controller forwards the right group prefix and parses the multipart `data`
// field before calling save.
import { ParameterController } from './parameter.controller';
import { ParameterService } from './parameter.service';

describe('ParameterController', () => {
  let service: { getGroup: jest.Mock; getAll: jest.Mock; save: jest.Mock };
  let controller: ParameterController;

  beforeEach(() => {
    service = {
      getGroup: jest.fn(),
      getAll: jest.fn(),
      save: jest.fn(),
    };
    controller = new ParameterController(
      service as unknown as ParameterService,
    );
  });

  it('getLogin forwards the login group prefix', async () => {
    service.getGroup.mockResolvedValue([]);
    await controller.getLogin();
    expect(service.getGroup).toHaveBeenCalledWith('login');
  });

  it('getChat forwards the chat group prefix', async () => {
    service.getGroup.mockResolvedValue([]);
    await controller.getChat();
    expect(service.getGroup).toHaveBeenCalledWith('chat');
  });

  it('findAll delegates to getAll', async () => {
    service.getAll.mockResolvedValue([]);
    await controller.findAll();
    expect(service.getAll).toHaveBeenCalled();
  });

  it('save parses the multipart data field and forwards items to the service', async () => {
    const saved = [{ pkey: 'login.default_login', pval: '0' }];
    service.save.mockResolvedValue(saved);

    const data = JSON.stringify([
      { pkey: 'login.default_login', pval: '0' },
      { pkey: 'chat.show_sql', pval: 'true' },
    ]);

    await expect(controller.save(data)).resolves.toEqual(saved);
    expect(service.save).toHaveBeenCalledWith([
      { pkey: 'login.default_login', pval: '0' },
      { pkey: 'chat.show_sql', pval: 'true' },
    ]);
  });
});
