// AppearanceController spec — locks the branding surface: the public UI read,
// the public picture stream (404 branch when the file is missing, sendFile
// with the service's path + media type when present), and the admin multipart
// save that tolerates missing files. Disk access lives in the service specs.
import { AppearanceController } from './appearance.controller';
import { AppearanceService } from './appearance.service';
import type { Response } from 'express';

describe('AppearanceController', () => {
  let appearanceService: {
    getUi: jest.Mock;
    exists: jest.Mock;
    pathFor: jest.Mock;
    mediaType: jest.Mock;
    save: jest.Mock;
  };
  let controller: AppearanceController;

  beforeEach(() => {
    appearanceService = {
      getUi: jest.fn(),
      exists: jest.fn(),
      pathFor: jest.fn(),
      mediaType: jest.fn(),
      save: jest.fn(),
    };
    controller = new AppearanceController(
      appearanceService as unknown as AppearanceService,
    );
  });

  it('getUi delegates to the service', async () => {
    appearanceService.getUi.mockResolvedValue({ logo: 'a.png' });
    await expect(controller.getUi()).resolves.toEqual({ logo: 'a.png' });
    expect(appearanceService.getUi).toHaveBeenCalled();
  });

  it('picture streams an existing file with path + media type', async () => {
    appearanceService.exists.mockResolvedValue(true);
    appearanceService.pathFor.mockReturnValue('/data/logo.png');
    appearanceService.mediaType.mockReturnValue('image/png');
    const res = { sendFile: jest.fn() } as unknown as Response;

    await controller.picture('logo.png', res);

    expect(res.sendFile).toHaveBeenCalledWith('/data/logo.png', {
      headers: { 'Content-Type': 'image/png' },
    });
  });

  it('picture 404s when the file does not exist', async () => {
    appearanceService.exists.mockResolvedValue(false);
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;

    await controller.picture('gone.png', res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith('File not found');
    expect(appearanceService.pathFor).not.toHaveBeenCalled();
  });

  it('save passes the data field and uploaded files to the service', async () => {
    appearanceService.save.mockResolvedValue(undefined);
    const files = [
      { fieldname: 'files', originalname: 'logo.png', buffer: Buffer.of(1) },
    ] as unknown as Express.Multer.File[];

    await expect(controller.save('{"logo":"x"}', files)).resolves.toBeNull();
    expect(appearanceService.save).toHaveBeenCalledWith('{"logo":"x"}', files);
  });

  it('save substitutes an empty array when no files were uploaded', async () => {
    appearanceService.save.mockResolvedValue(undefined);
    await expect(controller.save('{}', undefined)).resolves.toBeNull();
    expect(appearanceService.save).toHaveBeenCalledWith('{}', []);
  });
});
