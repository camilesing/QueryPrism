// AppearanceFileService spec — the validation + path-traversal guards that
// back the PUBLIC unauthenticated GET /system/appearance/picture/:file route
// and the admin upload (extension allowlist, 5MB cap, file-id shape,
// resolve stays inside the configured directory).
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AppearanceFileService } from './appearance-file.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function makeService(dir: string) {
  const config = {
    get: (key: string) => (key === 'appearance.uploadDir' ? dir : undefined),
  };
  return new AppearanceFileService(config as ConfigService);
}

function upload(originalname: string, size = 8, buffer = PNG) {
  return { originalname, size, buffer } as Express.Multer.File;
}

describe('AppearanceFileService.save', () => {
  beforeEach(() => setI18n(createTestI18n()));
  const dir = join(tmpdir(), `appearance-spec-${Date.now()}-${Math.random()}`);
  const service = makeService(dir);

  it('persists a valid image and returns an opaque file id', async () => {
    const fileId = await service.save(upload('logo.png,web'));
    expect(fileId).toMatch(/^[a-f0-9]{32}\.png$/);
    await expect(fs.access(join(dir, fileId))).resolves.toBeUndefined();
  });

  it('rejects a disallowed extension', async () => {
    await expect(service.save(upload('shell.sh,web'))).rejects.toThrow(
      'Only png/jpg/jpeg/svg/webp/gif',
    );
  });

  it('rejects files over 5MB', async () => {
    await expect(
      service.save(upload('big.png,web', 5 * 1024 * 1024 + 1)),
    ).rejects.toThrow('5MB');
  });

  it('extracts the extension from before the flag suffix, not the flag', async () => {
    // "<name>,<flag>" — a flag containing dots must not mask the extension
    const fileId = await service.save(upload('photo.jpeg,mobileLoginBg'));
    expect(fileId).toMatch(/^[a-f0-9]{32}\.jpe?g$/);
  });
});

describe('AppearanceFileService.resolve (public GET guard)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  const dir = join(tmpdir(), `appearance-spec-${Date.now()}-${Math.random()}`);
  const service = makeService(dir);

  beforeAll(async () => {
    // a real file so the happy path passes fs.access
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'a'.repeat(32) + '.png'), PNG);
  });

  it('serves an existing well-formed file id', async () => {
    await expect(service.exists('a'.repeat(32) + '.png')).resolves.toBe(true);
  });

  it('rejects traversal ids (never resolves outside the dir)', async () => {
    await expect(service.exists('../' + 'a'.repeat(32) + '.png')).resolves.toBe(
      false,
    );
    await expect(
      service.exists('..%2F' + 'a'.repeat(32) + '.png'),
    ).resolves.toBe(false);
  });

  it('rejects ids that do not match the generated shape', async () => {
    await expect(service.exists('not-a-file-id.png')).resolves.toBe(false);
    await expect(service.exists('Z'.repeat(32) + '.png')).resolves.toBe(false);
    // .php / .exe are not in the generated extension set
    await expect(service.exists('a'.repeat(32) + '.php')).resolves.toBe(false);
  });

  it('delete is a no-op for invalid ids (never unlinks outside the dir)', async () => {
    await expect(service.delete('../../etc/passwd')).resolves.toBeUndefined();
  });
});
