// apikey.service spec — 2026-09 review P0-2. The LIST must mask secret_key
// ('' — plaintext never leaves the server in bulk); the plaintext is only
// available through revealSecret, ownership-scoped (404, no existence leak).
// AES round-trips against the real encrypt/decrypt utils with a test key.
import { NotFoundException } from '@nestjs/common';
import { decrypt, encrypt } from '../common/utils/aes';
import { ApiKeyService } from './apikey.service';

const AES_KEY = 'unit-test-aes-key';

function makeRow(id: number, secretPlain: string, uid = 7) {
  return {
    id,
    accessKey: `ak-${id}`,
    secretKey: encrypt(secretPlain, AES_KEY),
    status: true,
    createdAt: new Date('2026-09-14T00:00:00Z'),
    uid,
  };
}

function makeService(rows: ReturnType<typeof makeRow>[]) {
  const prisma = {
    apiKey: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const config = {
    get: (k: string) => (k === 'aes.key' ? AES_KEY : undefined),
  };
  const service = new ApiKeyService(prisma as never, config as never);
  return { service, prisma };
}

describe('ApiKeyService (review P0-2)', () => {
  it('findAll MASKS secret_key to "" (no bulk plaintext on the list)', async () => {
    const { service } = makeService([makeRow(1, 'super-secret-plaintext')]);
    const out = await service.findAll(7);
    expect(out).toHaveLength(1);
    expect(out[0].secret_key).toBe('');
    expect(out[0].access_key).toBe('ak-1');
    expect(out[0].create_time).toBe(new Date('2026-09-14T00:00:00Z').getTime());
  });

  it('revealSecret decrypts and returns the plaintext for the OWNER', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(makeRow(3, 'the-real-secret'));
    const out = await service.revealSecret(3, 7);
    expect(out).toEqual({ id: 3, secret_key: 'the-real-secret' });
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 3, uid: 7 },
    });
  });

  it('revealSecret 404s when the key is missing or owned by someone else', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(service.revealSecret(999, 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ApiKeyService create/updateStatus/remove', () => {
  it('create generates access+secret keys, stores the secret encrypted, returns {id}', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.count.mockResolvedValue(4);
    prisma.apiKey.create.mockResolvedValue({ id: 11 });

    await expect(service.create(7)).resolves.toEqual({ id: 11 });

    const data = prisma.apiKey.create.mock.calls[0][0].data as {
      accessKey: string;
      secretKey: string;
      status: boolean;
      uid: number;
    };
    expect(data.accessKey).toMatch(/^[0-9a-f]{32}$/);
    expect(data.secretKey).toMatch(/^[^:]+:[^:]+:[^:]+$/); // iv:tag:cipher
    expect(decrypt(data.secretKey, AES_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(data.status).toBe(true);
    expect(data.uid).toBe(7);
  });

  it('create rejects beyond the 5-key cap without writing', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.count.mockResolvedValue(5);
    await expect(service.create(7)).rejects.toThrow(
      'Maximum of 5 API keys allowed',
    );
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('updateStatus toggles status when it differs', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(makeRow(1, 's'));
    await expect(service.updateStatus(1, 7, false)).resolves.toEqual({
      success: true,
    });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: false },
    });
  });

  it('updateStatus is a no-op write when the status is unchanged', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(makeRow(1, 's')); // status: true
    await expect(service.updateStatus(1, 7, true)).resolves.toEqual({
      success: true,
    });
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('updateStatus 404s for a missing or foreign key', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(service.updateStatus(9, 7, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('remove deletes an owned key', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(makeRow(2, 's'));
    await expect(service.remove(2, 7)).resolves.toEqual({ success: true });
    expect(prisma.apiKey.delete).toHaveBeenCalledWith({ where: { id: 2 } });
  });

  it('remove 404s for a missing or foreign key', async () => {
    const { service, prisma } = makeService([]);
    prisma.apiKey.findFirst.mockResolvedValue(null);
    await expect(service.remove(9, 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.apiKey.delete).not.toHaveBeenCalled();
  });
});
