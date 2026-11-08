// ImportErrorFileService spec — the download-handle guards behind
// POST /system/download-fail-info and GET /user/errorRecord/:key: the
// mandatory `_error.xlsx` suffix, basename/traversal rejection, and strict
// inside-directory resolution.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ImportErrorFileService } from './import-error-file.service';
import { setI18n } from '../i18n/translate';
import { createTestI18n } from '../i18n/test-i18n';

const dir = join(tmpdir(), `import-error-spec-${Date.now()}-${Math.random()}`);

function makeService() {
  const config = {
    get: (key: string) => (key === 'importError.dir' ? dir : undefined),
  };
  return new ImportErrorFileService(config as ConfigService);
}

async function writeFixture(service: ImportErrorFileService) {
  return service.write({
    prefix: 'terminology',
    headers: ['word', 'description'],
    rows: [['dup', 'x']],
    messages: ['术语「dup」已存在'],
  });
}

describe('ImportErrorFileService', () => {
  beforeEach(() => setI18n(createTestI18n()));
  const service = makeService();

  describe('write', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('writes the workbook and returns a valid handle', async () => {
      const filename = await writeFixture(service);
      expect(filename).toMatch(/^terminology_\d+_[a-f0-9]{8}_error\.xlsx$/);
      await expect(fs.access(join(dir, filename))).resolves.toBeUndefined();
    });

    it('rejects mismatched rows/messages lengths', async () => {
      await expect(
        service.write({
          prefix: 'user',
          headers: ['account'],
          rows: [['a'], ['b']],
          messages: ['one'],
        }),
      ).rejects.toThrow('length mismatch');
    });
  });

  describe('resolveDownload (download guard)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('resolves a handle written by write()', async () => {
      const filename = await writeFixture(service);
      await expect(service.resolveDownload(filename)).resolves.toBe(
        join(dir, filename),
      );
    });

    it('rejects traversal paths (404, stays inside the dir)', async () => {
      await expect(
        service.resolveDownload('../' + 'x'.repeat(8) + '_error.xlsx'),
      ).rejects.toThrow('File not found');
      await expect(
        service.resolveDownload('nested/' + 'x'.repeat(8) + '_error.xlsx'),
      ).rejects.toThrow('File not found');
    });

    it('rejects handles without the _error.xlsx suffix (400)', async () => {
      await expect(
        service.resolveDownload('users_export.xlsx'),
      ).rejects.toThrow('Only import error files can be downloaded');
      // even a real file with the wrong suffix is refused
      await fs.writeFile(join(dir, 'plain.txt'), 'x');
      await expect(service.resolveDownload('plain.txt')).rejects.toThrow(
        'Only import error files can be downloaded',
      );
    });

    it('rejects a well-formed handle that does not exist (404)', async () => {
      await expect(
        service.resolveDownload('terminology_1_deadbeef_error.xlsx'),
      ).rejects.toThrow('File not found');
    });
  });

  describe('delete', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('removes an existing handle and is a no-op for anything else', async () => {
      const filename = await writeFixture(service);
      await service.delete(filename);
      await expect(service.resolveDownload(filename)).rejects.toThrow(
        'File not found',
      );
      // invalid / missing handles do not throw
      await expect(service.delete('../../etc/passwd')).resolves.toBeUndefined();
      await expect(
        service.delete('terminology_1_deadbeef_error.xlsx'),
      ).resolves.toBeUndefined();
    });
  });
});
