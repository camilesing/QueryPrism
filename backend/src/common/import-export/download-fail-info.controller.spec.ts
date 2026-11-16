// DownloadFailInfoController spec — locks the failure-list Excel download:
// a missing `file` body fails fast with BadRequest, and the happy path
// resolves the stored path through the service and streams it via
// res.download(path, originalName). Path resolution/traversal guard lives in
// ImportErrorFileService's spec.
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { DownloadFailInfoController } from './download-fail-info.controller';
import { ImportErrorFileService } from './import-error-file.service';

describe('DownloadFailInfoController', () => {
  let files: { resolveDownload: jest.Mock };
  let controller: DownloadFailInfoController;
  let res: Response;

  beforeEach(() => {
    files = { resolveDownload: jest.fn() };
    controller = new DownloadFailInfoController(
      files as unknown as ImportErrorFileService,
    );
    res = { download: jest.fn() } as unknown as Response;
  });

  it('rejects a body without a file field', async () => {
    await expect(controller.download({}, res)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(files.resolveDownload).not.toHaveBeenCalled();
  });

  it('rejects an undefined body', async () => {
    await expect(
      controller.download(undefined as never, res),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('downloads the resolved path under the requested filename', async () => {
    files.resolveDownload.mockResolvedValue('/tmp/errs/imp-1.xlsx');

    await controller.download({ file: 'imp-1.xlsx' }, res);

    expect(files.resolveDownload).toHaveBeenCalledWith('imp-1.xlsx');
    expect(res.download).toHaveBeenCalledWith(
      '/tmp/errs/imp-1.xlsx',
      'imp-1.xlsx',
    );
  });
});
