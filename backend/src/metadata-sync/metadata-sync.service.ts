// CRUD for external metadata sync sources (MetaDataImprove M5). Sources are
// workspace-scoped; the creator becomes the run-as identity (must stay a
// workspace admin). Secrets are AES-encrypted and write-only.

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MetadataSyncSource } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { encryptJson } from '../common/utils/aes';
import { RequestContext } from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import type { MetadataSyncUpsertDto } from '../common/dtos/metadata-sync.dto';
import {
  isValidAuth,
  isValidCron,
  isValidEndpoint,
  type SyncAuth,
} from './metadata-sync-policy';
import {
  toMetadataSyncRunSnake,
  toMetadataSyncSourceSnake,
} from './metadata-sync-snake-mapper';
import { MetadataSyncSchedulerService } from './metadata-sync-scheduler.service';

@Injectable()
export class MetadataSyncService {
  private readonly logger = new Logger(MetadataSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scheduler: MetadataSyncSchedulerService,
  ) {}

  async list() {
    const actor = this.actor();
    const rows = await this.prisma.metadataSyncSource.findMany({
      where: { oid: actor.oid },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toMetadataSyncSourceSnake);
  }

  async create(dto: MetadataSyncUpsertDto) {
    this.validate(dto);
    const actor = this.actor();
    try {
      const row = await this.prisma.metadataSyncSource.create({
        data: {
          oid: actor.oid,
          name: dto.name.trim(),
          kind: dto.kind,
          target: dto.target,
          endpoint: dto.endpoint.trim(),
          httpMethod: dto.http_method ?? 'GET',
          httpBody:
            dto.kind === 'HTTP_API' && dto.http_body != null
              ? (dto.http_body as Prisma.InputJsonValue)
              : undefined,
          authJson:
            dto.auth && this.hasAuthContent(dto.auth)
              ? this.encryptAuth(dto.auth)
              : null,
          mcpTool: dto.kind === 'MCP' ? dto.mcp_tool?.trim() : null,
          mcpArgs:
            dto.kind === 'MCP' && dto.mcp_args != null
              ? (dto.mcp_args as Prisma.InputJsonValue)
              : undefined,
          cron: dto.cron?.trim() || null,
          enabled: dto.enabled ?? true,
          createdBy: actor.id,
        },
      });
      await this.refreshQuietly(row.id);
      return toMetadataSyncSourceSnake(row);
    } catch (e) {
      this.rethrowNameConflict(e);
    }
  }

  async update(dto: MetadataSyncUpsertDto) {
    if (dto.id == null) {
      throw new BadRequestException(tr('metadata-sync.missing_id'));
    }
    this.validate(dto);
    const actor = this.actor();
    const existing = await this.getOwned(dto.id, actor.oid);
    const isMcp = dto.kind === 'MCP';
    const httpMethod =
      !isMcp && dto.http_method ? dto.http_method : existing.httpMethod;
    try {
      const row = await this.prisma.metadataSyncSource.update({
        where: { id: existing.id },
        data: {
          name: dto.name.trim(),
          kind: dto.kind,
          target: dto.target,
          endpoint: dto.endpoint.trim(),
          httpMethod,
          // undefined keeps the stored value; null clears it.
          httpBody: isMcp
            ? Prisma.DbNull
            : dto.http_body === undefined
              ? undefined
              : dto.http_body === null
                ? Prisma.DbNull
                : (dto.http_body as Prisma.InputJsonValue),
          authJson:
            dto.auth === undefined
              ? undefined
              : dto.auth === null || !this.hasAuthContent(dto.auth)
                ? null
                : this.encryptAuth(dto.auth),
          mcpTool: isMcp ? (dto.mcp_tool?.trim() ?? null) : null,
          mcpArgs: isMcp
            ? dto.mcp_args === undefined
              ? undefined
              : dto.mcp_args === null
                ? Prisma.DbNull
                : (dto.mcp_args as Prisma.InputJsonValue)
            : Prisma.DbNull,
          cron:
            dto.cron === undefined
              ? undefined
              : dto.cron
                ? dto.cron.trim()
                : null,
          enabled: dto.enabled ?? existing.enabled,
        },
      });
      await this.refreshQuietly(row.id);
      return toMetadataSyncSourceSnake(row);
    } catch (e) {
      this.rethrowNameConflict(e);
    }
  }

  async remove(id: number) {
    const actor = this.actor();
    const existing = await this.getOwned(id, actor.oid);
    await this.prisma.metadataSyncSource.delete({ where: { id: existing.id } });
    this.scheduler.remove(existing.id);
    return { success: true };
  }

  async listRuns(id: number, currentPage: number, pageSize: number) {
    const actor = this.actor();
    await this.getOwned(id, actor.oid);
    const page = Math.max(1, currentPage);
    const size = Math.min(100, Math.max(1, pageSize));
    const [rows, total] = await Promise.all([
      this.prisma.metadataSyncRun.findMany({
        where: { sourceId: id },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.metadataSyncRun.count({ where: { sourceId: id } }),
    ]);
    return { data: rows.map(toMetadataSyncRunSnake), total_count: total };
  }

  private async getOwned(id: number, oid: number): Promise<MetadataSyncSource> {
    const row = await this.prisma.metadataSyncSource.findFirst({
      where: { id, oid },
    });
    if (!row) {
      throw new NotFoundException(tr('metadata-sync.not_found', { id }));
    }
    return row;
  }

  private actor(): { id: number; oid: number } {
    const user = RequestContext.getUser();
    if (!user) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return { id: user.id, oid: user.oid };
  }

  private validate(dto: MetadataSyncUpsertDto): void {
    if (!isValidEndpoint(dto.endpoint)) {
      throw new BadRequestException(tr('metadata-sync.invalid_endpoint'));
    }
    if (dto.cron != null && dto.cron.trim() !== '' && !isValidCron(dto.cron)) {
      throw new BadRequestException(tr('metadata-sync.invalid_cron'));
    }
    if (!isValidAuth(dto.auth)) {
      throw new BadRequestException(tr('metadata-sync.auth_invalid'));
    }
    if (dto.kind === 'MCP' && !dto.mcp_tool?.trim()) {
      throw new BadRequestException(tr('metadata-sync.missing_tool'));
    }
    if (dto.name.trim().length === 0) {
      throw new BadRequestException(tr('metadata-sync.missing_name'));
    }
  }

  private hasAuthContent(auth: SyncAuth): boolean {
    return !!auth.token?.trim() || Object.keys(auth.headers ?? {}).length > 0;
  }

  private encryptAuth(auth: SyncAuth): string {
    const key = this.config.get<string>('aes.key');
    if (!key) {
      throw new InternalServerErrorException(tr('metadata-sync.auth_invalid'));
    }
    return encryptJson(auth, key);
  }

  private async refreshQuietly(id: number): Promise<void> {
    try {
      await this.scheduler.refresh(id);
    } catch (e) {
      // The row is already saved; a scheduler glitch must not fail the save.
      this.logger.warn(
        `metadata sync #${id} scheduler refresh failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private rethrowNameConflict(e: unknown): never {
    if ((e as { code?: string }).code === 'P2002') {
      throw new BadRequestException(tr('metadata-sync.name_exists'));
    }
    throw e;
  }
}
