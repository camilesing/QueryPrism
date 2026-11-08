// ai-model.service spec — Phase 10 §67/§89. The service returns RAW AiModel rows
// (the snake mapping is applied at the controller layer, §77/§88) with these
// contract-specific behaviors:
//   - §89: `api_key`/`api_domain` arrive PLAINTEXT (xpack identity stub).
//     `create`/`update` AES-256-GCM-encrypt `apiKey` at rest (`encrypt(plain,
//     AES_KEY)`); `apiDomain` is stored PLAINTEXT (never encrypted).
//   - §67: `query(id)` (GET /:id) returns the row with `apiKey` DECRYPTED to
//     plaintext (the admin edit form's API Key field needs plaintext). Other
//     methods return the row with `apiKey` still encrypted — the controller's
//     list-mode mapper omits `api_key` + surfaces `has_api_key` only.
//   - `supplier`/`modelType`/`protocol` are stored as String (Prisma columns)
//     but the frontend sends NUMERIC enum ids. The service coerces
//     `String(...)` on write so Prisma's strict String columns accept numbers.
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { encrypt } from '../common/utils/aes';
import { PrismaService } from '../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { AiModelService } from './ai-model.service';

const TEST_KEY = 'test-aes-key-for-ai-model-spec-32';

// AES-256-GCM is symmetric: encrypt(plain, key) then decrypt(cipher, key) round-
// trips. The service uses the real `encrypt`/`decrypt` from common/utils/aes
// with `config.get('aes.key')` → TEST_KEY.
const enc = (plain: string) => encrypt(plain, TEST_KEY);

function mockRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    supplier: '1',
    name: 'qwen-plus',
    modelType: '0',
    baseModel: 'qwen-plus',
    defaultModel: false,
    apiKey: enc('sk-plaintext-secret'),
    apiDomain: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: '1',
    config: { temperature: 0.7 },
    status: 'active',
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    updatedAt: new Date('2026-07-25T11:00:00.000Z'),
    ...over,
  };
}

describe('AiModelService', () => {
  let service: AiModelService;
  let prisma: {
    aiModel: Record<string, jest.Mock>;
    aiModelWorkspaceMapping: Record<string, jest.Mock>;
  };
  let llm: { testConnection: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      aiModel: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn(),
      },
      aiModelWorkspaceMapping: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
    };
    llm = { testConnection: jest.fn() };
    config = {
      get: jest.fn((k: string) => (k === 'aes.key' ? TEST_KEY : undefined)),
    };

    const module = await Test.createTestingModule({
      providers: [
        AiModelService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
        { provide: ConfigService, useValue: config },
        // $transaction is called on the PrismaService itself.
      ],
    }).compile();
    // $transaction is called on the PrismaService itself.
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn();

    service = module.get(AiModelService);
  });

  describe('findAll (GET / list)', () => {
    it('returns raw rows ordered by default desc + created desc (no keyword)', async () => {
      // AES-256-GCM uses a random salt per call → ciphertext is non-deterministic.
      // Capture the mock's ciphertext + assert the service returns it verbatim
      // (does NOT decrypt for the list — list mode omits api_key at the mapper).
      const cipher = enc('sk-plaintext-secret');
      prisma.aiModel.findMany.mockResolvedValue([
        { ...mockRow(), apiKey: cipher },
      ]);
      const rows = await service.findAll();
      expect(prisma.aiModel.findMany).toHaveBeenCalledWith({
        orderBy: [{ defaultModel: 'desc' }, { createdAt: 'desc' }],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].apiKey).toBe(cipher);
      expect(rows[0].apiKey).not.toBe('sk-plaintext-secret');
    });

    it('filters by name contains when keyword is given (case-insensitive)', async () => {
      prisma.aiModel.findMany.mockResolvedValue([]);
      await service.findAll('qwen');
      expect(prisma.aiModel.findMany).toHaveBeenCalledWith({
        where: { name: { contains: 'qwen', mode: 'insensitive' } },
        orderBy: [{ defaultModel: 'desc' }, { createdAt: 'desc' }],
      });
    });
  });

  describe('query (GET /:id — §67 decrypt apiKey to plaintext)', () => {
    it('returns the row with apiKey DECRYPTED to plaintext', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(mockRow());
      const row = await service.query(1);
      expect(prisma.aiModel.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      // §67: the single-GET response surfaces plaintext api_key for the edit form.
      expect(row.apiKey).toBe('sk-plaintext-secret');
      // other fields unchanged
      expect(row.name).toBe('qwen-plus');
      expect(row.supplier).toBe('1');
    });

    it('throws 404 when the model is not found', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);
      await expect(service.query(99)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns null apiKey as null (not a decrypt attempt)', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(mockRow({ apiKey: null }));
      const row = await service.query(1);
      expect(row.apiKey).toBeNull();
    });
  });

  describe('create (POST / — §89 plaintext in, AES-256-GCM at rest)', () => {
    it('coerces numeric supplier/modelType/protocol to String + encrypts apiKey', async () => {
      prisma.aiModel.create.mockResolvedValue(mockRow());
      await service.create({
        supplier: 1,
        name: 'qwen-plus',
        modelType: 0,
        baseModel: 'qwen-plus',
        apiKey: 'sk-new',
        apiDomain: 'https://x',
        protocol: 1,
        status: 'active',
      } as never);
      expect(prisma.aiModel.create).toHaveBeenCalled();
      const call = prisma.aiModel.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      // Numeric enum ids are coerced to String for the strict String columns.
      expect(call.data.supplier).toBe('1');
      expect(call.data.modelType).toBe('0');
      expect(call.data.protocol).toBe('1');
      // §89: plaintext apiKey → AES-256-GCM ciphertext at rest (not the raw
      // 'sk-new').
      expect(call.data.apiKey).not.toBe('sk-new');
      expect(typeof call.data.apiKey).toBe('string');
      // apiDomain is stored PLAINTEXT (never encrypted).
      expect(call.data.apiDomain).toBe('https://x');
    });

    it('omits apiKey encryption when none provided', async () => {
      prisma.aiModel.create.mockResolvedValue(mockRow({ apiKey: null }));
      await service.create({
        supplier: 1,
        name: 'x',
        modelType: 0,
        protocol: 1,
      } as never);
      const call = prisma.aiModel.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.apiKey).toBeUndefined();
    });
  });

  describe('update (PUT / body-id — only provided fields)', () => {
    it('coerces + encrypts only the provided fields', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(mockRow());
      prisma.aiModel.update.mockResolvedValue(mockRow());
      await service.update(7, {
        name: 'renamed',
        apiKey: 'sk-rotated',
        protocol: 2,
      } as never);
      const call = prisma.aiModel.update.mock.calls[0][0] as {
        where: unknown;
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: 7 });
      expect(call.data.name).toBe('renamed');
      expect(call.data.protocol).toBe('2');
      expect(call.data.apiKey).not.toBe('sk-rotated');
      // fields not provided are NOT set (undefined → Prisma skips).
      expect(call.data.supplier).toBeUndefined();
      expect(call.data.modelType).toBeUndefined();
    });

    it('throws 404 when the model is not found', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);
      await expect(service.update(99, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove (DELETE /:id)', () => {
    it('deletes by id after confirming existence', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(mockRow());
      prisma.aiModel.delete.mockResolvedValue(mockRow());
      await service.remove(1);
      expect(prisma.aiModel.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws 404 when not found', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);
      await expect(service.remove(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setDefault (PUT /default/:id)', () => {
    it('transactionally flips other defaults + sets this one, returns raw row', async () => {
      prisma.aiModel.findUnique
        .mockResolvedValueOnce(mockRow()) // existence check
        .mockResolvedValueOnce(mockRow({ defaultModel: true })); // post-set fetch
      const row = await service.setDefault(1);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(row.defaultModel).toBe(true);
    });

    it('throws 404 when not found', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);
      await expect(service.setDefault(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listByWorkspace (GET /list/by_ws)', () => {
    it('returns mappings with the model + weight (raw, apiKey encrypted)', async () => {
      const cipher = enc('sk-plaintext-secret');
      prisma.aiModelWorkspaceMapping.findMany.mockResolvedValue([
        { weight: 5, model: { ...mockRow(), apiKey: cipher } },
      ]);
      const result = await service.listByWorkspace(3);
      expect(prisma.aiModelWorkspaceMapping.findMany).toHaveBeenCalledWith({
        where: { oid: 3 },
        include: { model: true },
        orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result).toHaveLength(1);
      expect(result[0].weight).toBe(5);
      // apiKey still encrypted (list mode; mapper omits it). Capture the
      // ciphertext — AES-256-GCM is non-deterministic (random salt).
      expect(result[0].model.apiKey).toBe(cipher);
      expect(result[0].model.apiKey).not.toBe('sk-plaintext-secret');
    });
  });

  describe('testStatus (POST /status — controller wraps as SSE)', () => {
    it('delegates to LlmService.testConnection after existence check', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(mockRow());
      llm.testConnection.mockResolvedValue({ success: true, message: 'ok' });
      const result = await service.testStatus(1);
      expect(llm.testConnection).toHaveBeenCalledWith(1);
      expect(result).toEqual({ success: true, message: 'ok' });
    });

    it('throws 404 when not found', async () => {
      prisma.aiModel.findUnique.mockResolvedValue(null);
      await expect(service.testStatus(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
