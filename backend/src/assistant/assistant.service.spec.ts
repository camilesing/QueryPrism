// AssistantService unit tests: oid-scoped admin CRUD (snake_case wire shape,
// §108) + AES-encrypted appSecret (plaintext NOT returned for type 0/1) +
// public findByAppId/getInfo (Phase 8/11 preserved) + listAllowedOrigins 60s
// cache (splits delimited domain string into individual origins) with
// mutation invalidation. Prisma + ConfigService are mocked; the workspace oid
// comes from running calls inside the real RequestContext AsyncLocalStorage.
import { BadRequestException } from '@nestjs/common';
import { requestContextStorage } from '../common/context/request-context';
import { AssistantService } from './assistant.service';
import { encrypt } from '../common/utils/aes';
import type { Assistant } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const AES_KEY = 'test-aes-key-32-bytes-min-length!!';

function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  assistant: {
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
};

type MockConfig = { get: jest.Mock };

function makeService(
  prisma: MockPrisma,
  config: MockConfig,
  fileService?: MockFileService,
) {
  return new AssistantService(
    prisma as unknown as never,
    config as unknown as never,
    fileService ?? makeFileService(),
  );
}

type MockFileService = {
  splitFilenameAndFlag: jest.Mock;
  checkFile: jest.Mock;
  upload: jest.Mock;
  pathFor: jest.Mock;
  exists: jest.Mock;
  delete: jest.Mock;
};

/** Build a mock AssistantFileService. `split`/`uploadId` seed the happy path;
 *  `checkThrows` makes checkFile throw (to assert BadRequest propagation). */
function makeFileService(opts?: {
  split?: { fileName: string; flagName: string };
  uploadId?: string;
  checkThrows?: boolean;
}): MockFileService {
  return {
    splitFilenameAndFlag: jest
      .fn()
      .mockReturnValue(
        opts?.split ?? { fileName: 'logo.png', flagName: 'logo' },
      ),
    checkFile: opts?.checkThrows
      ? jest.fn().mockImplementation(() => {
          throw new BadRequestException('文件类型不支持');
        })
      : jest.fn(),
    upload: jest.fn().mockResolvedValue(opts?.uploadId ?? 'NEW.png'),
    pathFor: jest.fn().mockReturnValue('/tmp/x'),
    exists: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

function ast(
  partial: Partial<Assistant> & { id: number; name: string; type: number },
): Assistant {
  return {
    oid: 1,
    description: null,
    domain: null,
    configuration: null,
    appId: 'app-' + partial.id,
    appSecret: 'enc-secret',
    enableCustomModel: false,
    customModel: null,
    picture: null,
    ui: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function makePrisma(): MockPrisma {
  return {
    assistant: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

function makeConfig(): MockConfig {
  return {
    get: jest.fn((key: string) => (key === 'aes.key' ? AES_KEY : undefined)),
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('AssistantService', () => {
  beforeEach(() => setI18n(createTestI18n()));
  let prisma: MockPrisma;
  let config: MockConfig;

  beforeEach(() => {
    prisma = makePrisma();
    config = makeConfig();
  });

  // --- admin list -------------------------------------------------------

  describe('list', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('is oid-scoped, excludes type==4 (embedded), ordered name+create_time', async () => {
      prisma.assistant.findMany.mockResolvedValue([
        ast({ id: 1, name: 'a', type: 0 }),
      ]);
      const out = await withUser(1, () => makeService(prisma, config).list());
      expect(prisma.assistant.findMany).toHaveBeenCalledWith({
        where: { oid: 1, type: { not: 4 } },
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      });
      expect(out).toHaveLength(1);
      // raw rows returned — controller maps via snake-mapper
      expect(out[0].appSecret).toBe('enc-secret');
    });
  });

  describe('listAdvancedApplications', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('filters type==1 only, oid-scoped, ordered name+create_time', async () => {
      prisma.assistant.findMany.mockResolvedValue([
        ast({ id: 7, name: 'adv', type: 1 }),
      ]);
      const out = await withUser(1, () =>
        makeService(prisma, config).listAdvancedApplications(),
      );
      expect(prisma.assistant.findMany).toHaveBeenCalledWith({
        where: { oid: 1, type: 1 },
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      });
      expect(out[0].id).toBe(7);
    });
  });

  // --- admin create -----------------------------------------------------

  describe('create', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('takes oid from context, generates appId (uuid) + AES-encrypted appSecret, stores snake-body fields, returns raw row (no plaintext secret)', async () => {
      prisma.assistant.create.mockResolvedValue(
        ast({ id: 5, name: 'demo', type: 0 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).create({
          name: 'demo',
          type: 0,
          description: 'a helper',
          domain: 'https://x.example.com',
          configuration: '{"oid":1,"public_list":[1,2]}',
          enable_custom_model: true,
          custom_model: 'gpt-4o',
        }),
      );
      // raw row returned (controller maps; appSecret stays internal)
      expect(out.id).toBe(5);
      expect(out.appSecret).toBe('enc-secret');
      const arg = prisma.assistant.create.mock.calls[0][0].data;
      expect(arg.oid).toBe(1);
      expect(arg.name).toBe('demo');
      expect(arg.type).toBe(0);
      expect(arg.description).toBe('a helper');
      expect(arg.domain).toBe('https://x.example.com');
      // configuration parsed from JSON STRING → object
      expect(arg.configuration).toEqual({ oid: 1, public_list: [1, 2] });
      expect(arg.enableCustomModel).toBe(true);
      expect(arg.customModel).toBe('gpt-4o');
      expect(arg.appId).toMatch(UUID_RE);
      // appSecret is AES-encrypted (not plaintext) — a non-UUID opaque blob
      expect(typeof arg.appSecret).toBe('string');
      expect(arg.appSecret).not.toMatch(UUID_RE);
    });

    it('skips optional fields when absent (partial create)', async () => {
      prisma.assistant.create.mockResolvedValue(
        ast({ id: 6, name: 'bare', type: 0 }),
      );
      await withUser(1, () =>
        makeService(prisma, config).create({ name: 'bare', type: 0 }),
      );
      const arg = prisma.assistant.create.mock.calls[0][0].data;
      expect(arg).not.toHaveProperty('description');
      expect(arg).not.toHaveProperty('domain');
      expect(arg).not.toHaveProperty('configuration');
      expect(arg).not.toHaveProperty('customModel');
    });
  });

  // --- admin update -----------------------------------------------------

  describe('update', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('takes id IN THE BODY (not path), verifies ownership, updates snake fields', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 9, name: 'old', type: 0 }),
      );
      prisma.assistant.update.mockResolvedValue(
        ast({ id: 9, name: 'new', type: 1 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).update({
          id: 9,
          name: 'new',
          type: 1,
          description: 'updated',
          domain: 'http://a.com;http://b.com',
          configuration: '{"auto_ds":true}',
          enable_custom_model: false,
          custom_model: 5,
          status: 'active',
        }),
      );
      expect(out.name).toBe('new');
      // ownership check used findFirst with {id, oid}
      expect(prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 9, oid: 1 },
      });
      const arg = prisma.assistant.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 9 });
      expect(arg.data.name).toBe('new');
      expect(arg.data.type).toBe(1);
      expect(arg.data.description).toBe('updated');
      expect(arg.data.domain).toBe('http://a.com;http://b.com');
      expect(arg.data.configuration).toEqual({ auto_ds: true });
      expect(arg.data.enableCustomModel).toBe(false);
      expect(arg.data.customModel).toBe(5);
      expect(arg.data.status).toBe('active');
    });

    it('throws BadRequest when id is missing from body', async () => {
      await expect(
        withUser(1, () =>
          makeService(prisma, config).update({ name: 'x', type: 0 }),
        ),
      ).rejects.toThrow('id is required');
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });

    it('throws NotFound when oid does not match (ownership)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () =>
          makeService(prisma, config).update({ id: 999, name: 'x' }),
        ),
      ).rejects.toThrow(/不存在/);
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });

    it('parses configuration JSON string; null domain clears; empty configuration skipped', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 8, name: 'x', type: 0 }),
      );
      prisma.assistant.update.mockResolvedValue(
        ast({ id: 8, name: 'x', type: 0 }),
      );
      await withUser(1, () =>
        makeService(prisma, config).update({
          id: 8,
          domain: null,
          configuration: '',
        }),
      );
      const arg = prisma.assistant.update.mock.calls[0][0].data;
      expect(arg.domain).toBeNull();
      expect(arg).not.toHaveProperty('configuration');
    });
  });

  // --- admin remove -----------------------------------------------------

  describe('updateUi (§A)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    const file = (name: string, buf = Buffer.from('x')) =>
      ({
        originalname: name,
        buffer: buf,
        size: buf.byteLength,
      }) as Express.Multer.File;

    it('uploads a logo file, deletes the prior file_id, merges schema attrs', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({
          id: 5,
          name: 'A',
          type: 0,
          configuration: { logo: 'OLD.png', theme: 'red' },
        }),
      );
      prisma.assistant.findUnique.mockResolvedValue(
        ast({
          id: 5,
          name: 'A',
          type: 0,
          configuration: { logo: 'OLD.png', theme: 'red' },
        }),
      );
      const updated = ast({ id: 5, name: 'A', type: 0 });
      prisma.assistant.update.mockResolvedValue(updated);

      const fileMock = makeFileService({ uploadId: 'NEW.png' });
      const f = file('logo.png,logo');
      const row = await withUser(1, () =>
        makeService(prisma, config, fileMock).updateUi(
          { id: 5, theme: 'blue' },
          [f],
        ),
      );

      // file routed via the comma-split flag; validated + uploaded; old deleted
      expect(fileMock.splitFilenameAndFlag).toHaveBeenCalledWith(
        'logo.png,logo',
      );
      expect(fileMock.checkFile).toHaveBeenCalledWith(f);
      expect(fileMock.upload).toHaveBeenCalledWith(f);
      expect(fileMock.delete).toHaveBeenCalledWith('OLD.png');
      // persisted configuration merges the new logo file_id + the theme attr
      expect(prisma.assistant.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { configuration: { logo: 'NEW.png', theme: 'blue' } },
      });
      expect(row).toBe(updated);
    });

    it('clears an existing logo when the schema does not resend it', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({
          id: 5,
          name: 'A',
          type: 0,
          configuration: { logo: 'OLD.png', theme: 'red' },
        }),
      );
      prisma.assistant.findUnique.mockResolvedValue(
        ast({
          id: 5,
          name: 'A',
          type: 0,
          configuration: { logo: 'OLD.png', theme: 'red' },
        }),
      );
      prisma.assistant.update.mockResolvedValue(
        ast({ id: 5, name: 'A', type: 0 }),
      );

      await withUser(1, () =>
        makeService(prisma, config, makeFileService({})).updateUi(
          { id: 5, theme: 'red' }, // no logo, no files
          [],
        ),
      );

      const arg = prisma.assistant.update.mock.calls[0][0].data;
      // logo nulled (the client didn't resend it) + theme carried through
      expect(arg.configuration).toEqual({ logo: null, theme: 'red' });
    });

    it('rejects an unsupported file flag', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 5, name: 'A', type: 0, configuration: {} }),
      );
      prisma.assistant.findUnique.mockResolvedValue(
        ast({ id: 5, name: 'A', type: 0, configuration: {} }),
      );
      await expect(
        withUser(1, () =>
          makeService(
            prisma,
            config,
            makeFileService({
              split: { fileName: 'x.gif', flagName: 'avatar' },
            }),
          ).updateUi({ id: 5 }, [file('x.gif,avatar')]),
        ),
      ).rejects.toThrow(BadRequestException);
      // prisma never written (validation preempts the update)
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });

    it('propagates a checkFile rejection as BadRequest (before any update)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 5, name: 'A', type: 0, configuration: {} }),
      );
      prisma.assistant.findUnique.mockResolvedValue(
        ast({ id: 5, name: 'A', type: 0, configuration: {} }),
      );
      await expect(
        withUser(1, () =>
          makeService(
            prisma,
            config,
            makeFileService({
              split: { fileName: 'x.gif', flagName: 'logo' },
              checkThrows: true,
            }),
          ).updateUi({ id: 5 }, [file('x.gif,logo')]),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });

    it('400s when id is missing', async () => {
      await expect(
        withUser(1, () => makeService(prisma, config).updateUi({}, [])),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('deletes after oid-scoped existence check, returns {success:true}', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 3, name: 'gone', type: 0 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).remove(3),
      );
      expect(out).toEqual({ success: true });
      expect(prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 3, oid: 1 },
      });
      expect(prisma.assistant.delete).toHaveBeenCalledWith({
        where: { id: 3 },
      });
    });

    it('throws NotFound when missing', async () => {
      prisma.assistant.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () => makeService(prisma, config).remove(404)),
      ).rejects.toThrow(/不存在/);
      expect(prisma.assistant.delete).not.toHaveBeenCalled();
    });
  });

  // --- embedded admin (type==4, /system/embedded, §109) ----------------

  describe('listEmbedded', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('filters type==4 oid-scoped, paginates (1-indexed), keyword name-contains, returns {items, total}', async () => {
      prisma.assistant.findMany.mockResolvedValue([
        ast({ id: 11, name: 'embed-a', type: 4 }),
      ]);
      prisma.assistant.count.mockResolvedValue(1);
      const out = await withUser(1, () =>
        makeService(prisma, config).listEmbedded(1, 10, 'embed'),
      );
      expect(out).toEqual({
        items: [expect.objectContaining({ id: 11, type: 4 })],
        total: 1,
      });
      expect(prisma.assistant.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          type: 4,
          name: { contains: 'embed', mode: 'insensitive' },
        },
        skip: 0,
        take: 10,
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      });
      expect(prisma.assistant.count).toHaveBeenCalledWith({
        where: {
          oid: 1,
          type: 4,
          name: { contains: 'embed', mode: 'insensitive' },
        },
      });
    });

    it('skip = (pageNum-1)*pageSize for page 2; no keyword → name filter absent', async () => {
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.assistant.count.mockResolvedValue(15);
      await withUser(1, () => makeService(prisma, config).listEmbedded(2, 10));
      expect(prisma.assistant.findMany.mock.calls[0][0].skip).toBe(10);
      expect(
        prisma.assistant.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('name');
    });
  });

  describe('createEmbedded', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('forces type==4, generates appId (uuid) + AES-encrypted appSecret, parses snake-body fields', async () => {
      prisma.assistant.create.mockResolvedValue(
        ast({ id: 12, name: 'embed-new', type: 4 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).createEmbedded({
          name: 'embed-new',
          domain: 'https://embed.example.com',
          configuration: '{"oid":1,"theme":"dark"}',
          description: 'an embedded app',
        }),
      );
      expect(out.id).toBe(12);
      const arg = prisma.assistant.create.mock.calls[0][0].data;
      expect(arg.oid).toBe(1);
      expect(arg.name).toBe('embed-new');
      expect(arg.type).toBe(4); // forced — body.type is absent, but type is 4
      expect(arg.appId).toMatch(UUID_RE);
      expect(arg.domain).toBe('https://embed.example.com');
      expect(arg.description).toBe('an embedded app');
      expect(arg.configuration).toEqual({ oid: 1, theme: 'dark' });
      // appSecret AES-encrypted (not plaintext, not a UUID)
      expect(typeof arg.appSecret).toBe('string');
      expect(arg.appSecret).not.toMatch(UUID_RE);
    });
  });

  describe('updateEmbedded', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('takes id-in-body, ownership verified, type is IGNORED (immutable)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 14, name: 'old', type: 4 }),
      );
      prisma.assistant.update.mockResolvedValue(
        ast({ id: 14, name: 'new', type: 4 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).updateEmbedded({
          id: 14,
          name: 'new',
          type: 0, // body.type present — must be ignored (route is type-4-only)
          domain: 'https://new.example.com',
          configuration: '{"oid":1,"theme":"light"}',
        }),
      );
      expect(out.name).toBe('new');
      expect(prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 14, oid: 1 },
      });
      const arg = prisma.assistant.update.mock.calls[0][0].data;
      expect(arg.name).toBe('new');
      expect(arg.domain).toBe('https://new.example.com');
      expect(arg.configuration).toEqual({ oid: 1, theme: 'light' });
      // type is immutable on the embedded route — never in update data
      expect(arg).not.toHaveProperty('type');
      expect(arg).not.toHaveProperty('description');
    });

    it('throws BadRequest when id missing from body', async () => {
      await expect(
        withUser(1, () =>
          makeService(prisma, config).updateEmbedded({ name: 'x' }),
        ),
      ).rejects.toThrow('id is required');
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });

    it('throws NotFound when oid mismatch (ownership)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () =>
          makeService(prisma, config).updateEmbedded({ id: 999, name: 'x' }),
        ),
      ).rejects.toThrow(/不存在/);
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });
  });

  describe('removeEmbedded', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('batch deleteMany oid-scoped, returns {success:true}', async () => {
      const out = await withUser(1, () =>
        makeService(prisma, config).removeEmbedded([1, 2, 3]),
      );
      expect(out).toEqual({ success: true });
      expect(prisma.assistant.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2, 3] }, oid: 1 },
      });
    });

    it('empty array still calls deleteMany (no-op: no rows match)', async () => {
      const out = await withUser(1, () =>
        makeService(prisma, config).removeEmbedded([]),
      );
      expect(out).toEqual({ success: true });
      expect(prisma.assistant.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [] }, oid: 1 },
      });
    });
  });

  describe('rotateSecret', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('ownership check, AES-encrypts a new secret, stores; returns {success:true}', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 20, name: 'x', type: 4, appSecret: 'old-enc' }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).rotateSecret(20),
      );
      expect(out).toEqual({ success: true });
      expect(prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { id: 20, oid: 1 },
      });
      const arg = prisma.assistant.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 20 });
      expect(arg.data.appSecret).not.toBe('old-enc'); // changed
      expect(typeof arg.data.appSecret).toBe('string');
    });

    it('throws NotFound when oid mismatch', async () => {
      prisma.assistant.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () => makeService(prisma, config).rotateSecret(404)),
      ).rejects.toThrow(/不存在/);
      expect(prisma.assistant.update).not.toHaveBeenCalled();
    });
  });

  describe('decryptAppSecret', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('round-trips an AES-encrypted plaintext (encrypt → decryptAppSecret → plaintext)', () => {
      const svc = makeService(prisma, config);
      const plain =
        'a-real-plaintext-secret-64-hex-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const ciphertext = encrypt(plain, AES_KEY);
      // sanity: ciphertext is not the plaintext (actually encrypted)
      expect(ciphertext).not.toBe(plain);
      expect(svc.decryptAppSecret(ciphertext)).toBe(plain);
    });
  });

  // --- public (preserved Phase 8/11) ------------------------------------

  describe('findByAppId (public)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('no oid scope, only active, returns safe (appSecret stripped) + 404 when missing', async () => {
      prisma.assistant.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () => makeService(prisma, config).findByAppId('nope')),
      ).rejects.toThrow(/不存在或已下线/);
      expect(prisma.assistant.findFirst).toHaveBeenCalledWith({
        where: { appId: 'nope', status: 'active' },
      });
    });

    it('returns safe assistant (no appSecret) on hit', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 2, name: 'pub', type: 0 }),
      );
      const out = await withUser(1, () =>
        makeService(prisma, config).findByAppId('app-2'),
      );
      expect(out.id).toBe(2);
      expect(out).not.toHaveProperty('appSecret');
    });
  });

  describe('getInfo (public projection)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('returns render-relevant fields only (no id/appId/status/oid)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 2, name: 'pub', type: 0, configuration: { oid: 1 } }),
      );
      const info = await withUser(1, () =>
        makeService(prisma, config).getInfo('app-2'),
      );
      expect(info.name).toBe('pub');
      expect(info.type).toBe(0);
      expect(info.configuration).toEqual({ oid: 1 });
      expect(info).not.toHaveProperty('id');
      expect(info).not.toHaveProperty('appId');
      expect(info).not.toHaveProperty('status');
      expect(info).not.toHaveProperty('oid');
      expect(info).not.toHaveProperty('appSecret');
    });
  });

  // --- dynamic CORS source (preserved + domain-split improvement) -------

  describe('listAllowedOrigins (CORS cache)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('queries distinct active domains and splits delimited string into individual origins', async () => {
      prisma.assistant.findMany.mockResolvedValue([
        { domain: 'http://a.com,http://b.com' },
        { domain: 'http://c.com' },
        { domain: ' http://d.com ; http://e.com ' },
      ]);
      const out = await withUser(1, () =>
        makeService(prisma, config).listAllowedOrigins(),
      );
      // each published host allowed independently (§108 improvement over
      // Phase 8 which returned the raw delimited string — broken for multi-domain)
      expect(out.sort()).toEqual(
        [
          'http://a.com',
          'http://b.com',
          'http://c.com',
          'http://d.com',
          'http://e.com',
        ].sort(),
      );
      expect(prisma.assistant.findMany).toHaveBeenCalledWith({
        where: { domain: { not: null }, status: 'active' },
        select: { domain: true },
      });
    });

    it('caches for 60s (second read does not re-query)', async () => {
      prisma.assistant.findMany.mockResolvedValue([{ domain: 'http://x.com' }]);
      const svc = makeService(prisma, config);
      await withUser(1, () => svc.listAllowedOrigins());
      await withUser(1, () => svc.listAllowedOrigins());
      expect(prisma.assistant.findMany).toHaveBeenCalledTimes(1);
    });

    it('mutations invalidate the cache (next read re-queries)', async () => {
      prisma.assistant.findFirst.mockResolvedValue(
        ast({ id: 1, name: 'x', type: 0 }),
      );
      prisma.assistant.findMany.mockResolvedValue([{ domain: 'http://x.com' }]);
      const svc = makeService(prisma, config);
      await withUser(1, () => svc.listAllowedOrigins());
      await withUser(1, () => svc.remove(1));
      await withUser(1, () => svc.listAllowedOrigins());
      expect(prisma.assistant.findMany).toHaveBeenCalledTimes(2);
    });

    it('isOriginAllowed returns true for a published origin, false otherwise', async () => {
      prisma.assistant.findMany.mockResolvedValue([{ domain: 'http://x.com' }]);
      const svc = makeService(prisma, config);
      await expect(
        withUser(1, () => svc.isOriginAllowed('http://x.com')),
      ).resolves.toBe(true);
      await expect(
        withUser(1, () => svc.isOriginAllowed('http://evil.com')),
      ).resolves.toBe(false);
    });

    it('isOriginAllowed fails closed when the lookup throws', async () => {
      prisma.assistant.findMany.mockRejectedValue(new Error('db down'));
      const svc = makeService(prisma, config);
      await expect(
        withUser(1, () => svc.isOriginAllowed('http://x.com')),
      ).resolves.toBe(false);
    });
  });
});
