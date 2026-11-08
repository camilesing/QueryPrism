// McpIntegrationService — workspace-scoped MCP service credentials.
//
// A workspace may create multiple named integrations (one per external Agent),
// each with its own token so access can be revoked per integration without
// disturbing the others. Token format:
//
//   qp_<32-hex accessKey>.<64-hex secret>
//
// `accessKey` is the public lookup key (`@@unique`); `secretKey` is
// AES-256-GCM encrypted at rest (common/utils/aes.ts) and only leaves the
// server through create / rotate / the explicit reveal route.
//
// The MCP endpoint authenticates via `Authorization: Bearer <token>`:
// authenticateBearer() resolves the integration, timing-safe-compares the
// secret, rejects disabled integrations and archived workspaces, and returns a
// synthetic CurrentUserInfo so the chat/datasource services can resolve the
// workspace through RequestContext (ALS).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { McpIntegration, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  RequestContext,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { decrypt, encrypt } from '../common/utils/aes';
import { tr } from '../common/i18n/translate';

export interface McpIntegrationMutateBody {
  id?: number | string;
  name?: string;
  description?: string | null;
  status?: string;
}

export interface AuthenticatedMcpIntegration {
  integration: McpIntegration;
  user: CurrentUserInfo;
}

const TOKEN_PREFIX = 'qp_';
const STATUS_ACTIVE = 'active';

@Injectable()
export class McpIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get aesKey(): string {
    return this.config.get<string>('aes.key')!;
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  /** Full plaintext token for a row (accessKey + decrypted secret). */
  private tokenFor(row: McpIntegration): string {
    return `${row.accessKey}.${decrypt(row.secretKey, this.aesKey)}`;
  }

  // --- admin CRUD ---------------------------------------------------------

  async list(keyword?: string): Promise<McpIntegration[]> {
    const oid = this.currentOid();
    const term = keyword?.trim();
    return this.prisma.mcpIntegration.findMany({
      where: {
        oid,
        ...(term
          ? { name: { contains: term, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async create(
    body: McpIntegrationMutateBody,
  ): Promise<{ row: McpIntegration; token: string }> {
    const name = body.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const oid = this.currentOid();
    const accessKey = `${TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');

    const row = await this.prisma.mcpIntegration.create({
      data: {
        oid,
        name,
        description: body.description ?? null,
        accessKey,
        secretKey: encrypt(secret, this.aesKey),
        createdBy: RequestContext.getUserId() ?? 1,
      },
    });
    return { row, token: `${accessKey}.${secret}` };
  }

  async update(body: McpIntegrationMutateBody): Promise<McpIntegration> {
    if (body.id == null || body.id === '') {
      throw new BadRequestException('id is required');
    }
    const id = Number(body.id);
    const oid = this.currentOid();

    const data: {
      name?: string;
      description?: string | null;
      status?: string;
    } = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) {
        throw new BadRequestException('name cannot be empty');
      }
      data.name = name;
    }
    if (body.description !== undefined) {
      data.description = body.description;
    }
    if (body.status !== undefined) {
      if (body.status !== STATUS_ACTIVE && body.status !== 'disabled') {
        throw new BadRequestException('status must be active or disabled');
      }
      data.status = body.status;
    }
    // The workspace-scoped existence check and the write share ONE
    // transaction, so a concurrent delete surfaces as 404, not a P2025 500.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.mcpIntegration.findFirst({
        where: { id, oid },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(tr('mcp.integration_not_found', { id }));
      }
      return tx.mcpIntegration.update({ where: { id }, data });
    });
  }

  async remove(id: number): Promise<{ success: true }> {
    const oid = this.currentOid();
    const result = await this.prisma.mcpIntegration.deleteMany({
      where: { id, oid },
    });
    if (result.count === 0) {
      throw new NotFoundException(tr('mcp.integration_not_found', { id }));
    }
    return { success: true };
  }

  async revealToken(id: number): Promise<string> {
    const row = await this.findOwned(id);
    return this.tokenFor(row);
  }

  async rotateToken(id: number): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    const row = await this.prisma.$transaction(async (tx) => {
      const owned = await this.findOwned(id, tx);
      await tx.mcpIntegration.update({
        where: { id: owned.id },
        data: { secretKey: encrypt(secret, this.aesKey) },
      });
      return owned;
    });
    return `${row.accessKey}.${secret}`;
  }

  // --- endpoint auth ------------------------------------------------------

  /**
   * Resolve a Bearer token to its integration + synthetic request identity.
   * Every failure path throws the same UnauthorizedException so callers cannot
   * probe which access keys exist. Disabled integrations and archived
   * workspaces are rejected immediately.
   */
  async authenticateBearer(
    rawToken: string,
  ): Promise<AuthenticatedMcpIntegration> {
    const token = rawToken?.trim() ?? '';
    const dot = token.indexOf('.');
    if (
      !token.startsWith(TOKEN_PREFIX) ||
      dot <= 0 ||
      dot === token.length - 1
    ) {
      throw new UnauthorizedException(tr('mcp.token_invalid'));
    }
    const accessKey = token.slice(0, dot);
    const presented = token.slice(dot + 1);

    const row = await this.prisma.mcpIntegration.findUnique({
      where: { accessKey },
    });
    if (!row || row.status !== STATUS_ACTIVE) {
      throw new UnauthorizedException(tr('mcp.token_invalid'));
    }

    let expected: string;
    try {
      expected = decrypt(row.secretKey, this.aesKey);
    } catch {
      throw new UnauthorizedException(tr('mcp.token_invalid'));
    }
    const presentedBuf = Buffer.from(presented, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      presentedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(presentedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException(tr('mcp.token_invalid'));
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: row.oid },
      select: { archivedAt: true },
    });
    if (!workspace || workspace.archivedAt != null) {
      throw new UnauthorizedException(tr('mcp.ws_unavailable'));
    }

    // Fire-and-forget: usage tracking must never delay or fail a tool call.
    void this.prisma.mcpIntegration
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      integration: row,
      user: {
        id: row.createdBy,
        account: `mcp:${row.name}`,
        oid: row.oid,
        language: 'zh-CN',
        weight: 0,
      },
    };
  }

  private async findOwned(
    id: number,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<McpIntegration> {
    const oid = this.currentOid();
    const row = await client.mcpIntegration.findFirst({
      where: { id, oid },
    });
    if (!row) {
      throw new NotFoundException(tr('mcp.integration_not_found', { id }));
    }
    return row;
  }
}
