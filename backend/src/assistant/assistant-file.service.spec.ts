// AssistantFileService unit tests (§A — Phase 11). File I/O is exercised
// against an OS temp dir (per-test mkdtemp → rm cleanup) so nothing touches
// the repo. ConfigService is mocked to surface `assistant.uploadDir`.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssistantFileService } from './assistant-file.service';

type MulterFile = Express.Multer.File;

function makeFile(
  originalname: string,
  buffer: Buffer,
  size?: number,
): MulterFile {
  // Express.Multer.File is a structural type; a plain object satisfies it for
  // the fields AssistantFileService reads (originalname/size/buffer).
  return {
    originalname,
    buffer,
    size: size ?? buffer.byteLength,
  } as MulterFile;
}

function makeService(uploadDir: string): AssistantFileService {
  return new AssistantFileService({
    get: (k: string) => (k === 'assistant.uploadDir' ? uploadDir : undefined),
  } as never);
}

describe('AssistantFileService', () => {
  let dir: string;
  let service: AssistantFileService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'asst-up-'));
    service = makeService(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('splitFilenameAndFlag', () => {
    it('splits "<name>,<flag>" on the LAST comma', () => {
      expect(service.splitFilenameAndFlag('logo.png,logo')).toEqual({
        fileName: 'logo.png',
        flagName: 'logo',
      });
      expect(service.splitFilenameAndFlag('icon.png,float_icon')).toEqual({
        fileName: 'icon.png',
        flagName: 'float_icon',
      });
    });
    it('keeps embedded commas in the filename', () => {
      // SetUi.vue appends exactly one ",<flag>"; the filename itself may
      // contain commas — last-comma split keeps them.
      expect(service.splitFilenameAndFlag('a,b,logo')).toEqual({
        fileName: 'a,b',
        flagName: 'logo',
      });
    });
    it('returns empty flag when there is no comma', () => {
      expect(service.splitFilenameAndFlag('logo.png')).toEqual({
        fileName: 'logo.png',
        flagName: '',
      });
    });
  });

  describe('checkFile', () => {
    it('accepts jpg/jpeg/png under the size limit', () => {
      const buf = Buffer.from('x');
      expect(() => service.checkFile(makeFile('a.jpg', buf))).not.toThrow();
      expect(() => service.checkFile(makeFile('a.JPEG', buf))).not.toThrow();
      expect(() => service.checkFile(makeFile('a.png', buf))).not.toThrow();
    });
    it('rejects unsupported extensions', () => {
      expect(() =>
        service.checkFile(makeFile('a.gif', Buffer.from('x'))),
      ).toThrow(BadRequestException);
      expect(() =>
        service.checkFile(makeFile('noext', Buffer.from('x'))),
      ).toThrow(BadRequestException);
    });
    it('rejects files over 10 MB', () => {
      const big = Buffer.from('x');
      expect(() =>
        service.checkFile(makeFile('a.png', big, 10 * 1024 * 1024 + 1)),
      ).toThrow(BadRequestException);
    });
  });

  describe('upload / pathFor / exists / delete', () => {
    it('upload persists the buffer under a generated file_id with extension', async () => {
      const fileId = await service.upload(
        makeFile('company.png', Buffer.from('PNGDATA')),
      );
      expect(fileId).toMatch(/^[0-9a-f]{16}\.png$/);
      expect(await service.exists(fileId)).toBe(true);
      const onDisk = await fs.readFile(service.pathFor(fileId));
      expect(onDisk.toString()).toBe('PNGDATA');
    });

    it('upload creates the upload dir if it does not exist', async () => {
      const nested = join(dir, 'nested', 'deep');
      const s = makeService(nested);
      const fileId = await s.upload(makeFile('x.png', Buffer.from('y')));
      expect(await s.exists(fileId)).toBe(true);
    });

    it('exists returns false for a missing file_id', async () => {
      expect(await service.exists('nonexistent.png')).toBe(false);
    });

    it('upload enforces checkFile internally (bad extension rejected)', async () => {
      await expect(
        service.upload(makeFile('evil.gif', Buffer.from('x'))),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.upload(
          makeFile('huge.png', Buffer.from('x'), 10 * 1024 * 1024 + 1),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delete removes the file and is a no-op when missing or null', async () => {
      const fileId = await service.upload(makeFile('a.png', Buffer.from('z')));
      await service.delete(fileId);
      expect(await service.exists(fileId)).toBe(false);
      // no-op on already-missing + on null/undefined
      await expect(service.delete(fileId)).resolves.toBeUndefined();
      await expect(service.delete(null)).resolves.toBeUndefined();
      await expect(service.delete(undefined)).resolves.toBeUndefined();
    });

    it('pathFor rejects traversal-shaped file_ids outright (2026-09 review P0-3)', () => {
      // `..`, `.`, separators, null bytes, absolute paths, and non-generated
      // shapes must all throw — the old strip-separators approach let `..`,
      // `.`, and NUL through join().
      const rd = resolve(dir);
      for (const evil of [
        '..',
        '.',
        '../escape',
        '..\\escape',
        '../../etc/passwd',
        'sub/x.png',
        '/etc/passwd',
        'a\0b.png',
        '0123456789abcdef', // valid hex length, no ext — allowed shape
        '0123456789abcdef.svg', // extension outside the whitelist
        'short.png',
        '0123456789gbcdef.png', // non-hex char
      ]) {
        if (evil === '0123456789abcdef') continue; // valid: asserted below
        expect(() => service.pathFor(evil)).toThrow(NotFoundException);
        const p = (() => {
          try {
            return service.pathFor(evil);
          } catch {
            return null;
          }
        })();
        expect(p === null || p === rd || p.startsWith(rd + sep)).toBe(true);
      }
    });

    it('pathFor accepts exactly the generated-id shape', () => {
      expect(service.pathFor('0123456789abcdef')).toBe(
        join(resolve(dir), '0123456789abcdef'),
      );
      expect(service.pathFor('0123456789ABCDEF.PNG')).toBe(
        join(resolve(dir), '0123456789ABCDEF.PNG'),
      );
    });

    it('exists() returns false for traversal ids (no directory probing)', async () => {
      expect(await service.exists('..')).toBe(false);
      expect(await service.exists('.')).toBe(false);
      expect(await service.exists('../')).toBe(false);
    });

    it('exists() returns false when the id shape is valid but the entry is a directory', async () => {
      await fs.mkdir(join(dir, 'aaaaaaaaaaaaaaaa.png'));
      expect(await service.exists('aaaaaaaaaaaaaaaa.png')).toBe(false);
    });
  });
});
