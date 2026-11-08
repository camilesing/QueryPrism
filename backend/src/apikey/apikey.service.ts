// apikey.service — Phase 10c cycle 1 §82/§99. Per-user programmatic-access
// keys, aligned to the `/system/apikey` wire contract. The frontend
// (Apikey.vue) is the source of truth; this service adapts to it.
//
// Contract notes (reverse-engineered from the frontend, Apikey.vue):
//   - Keys are scoped to their owner (`uid`); GET list filters
//     `where uid == currentUser.id`.
//     Mutations verify ownership and 404 otherwise (don't leak existence).
//   - POST create takes NO body (frontend sends `{}`); the server generates
//     both `access_key` + `secret_key`
//     (`randomBytes(...).toString('hex')` here). Enforces max 5 keys/user.
//     Returns just `{id}`; the frontend ignores the response +
//     re-GETs the list.
//   - PUT /status body `{id, status: boolean}` toggles status. No-op if
//     unchanged.
//   - DELETE /:id.
//   - `secret_key` is stored AES-256-GCM-encrypted at rest (§99) and is
//     NEVER returned by the list (masked to '' — 2026-09 review P0-2). The
//     plaintext is revealed one key at a time through the dedicated
//     reveal-on-demand route (GET /system/apikey/:id/secret) for the
//     frontend's show/copy actions — recorded in the review improvement
//     plan.
//   - `status` is Boolean (stored as Boolean in the DB).
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { decrypt, encrypt } from '../common/utils/aes';
import { toApiKeySnake, type ApiKeySnake } from './apikey-snake-mapper';
import { tr } from '../common/i18n/translate';

const MAX_KEYS_PER_USER = 5;

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get aesKey(): string {
    return this.config.get<string>('aes.key')!;
  }

  /** List the current user's keys, newest-first (create_time descending).
   *  `secret_key` is MASKED
   *  (empty string) — the plaintext leaves the server ONLY through
   *  revealSecret (2026-09 review P0-2: this list used to decrypt and return
   *  EVERY key's secret on every page load, so one XSS/log leak exposed all
   *  of a user's keys at once). */
  async findAll(uid: number): Promise<ApiKeySnake[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { uid },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) =>
      toApiKeySnake({
        id: row.id,
        accessKey: row.accessKey,
        secretKey: '', // masked — reveal on demand via revealSecret()
        status: row.status,
        createdAt: row.createdAt,
      }),
    );
  }

  /** Reveal ONE key's plaintext secret_key, on demand (review P0-2 — the
   *  frontend's show/copy actions call this per row). Ownership-scoped: 404
   *  when the key doesn't exist OR belongs to someone else (no existence
   *  leak, same contract as updateStatus/remove). */
  async revealSecret(
    id: number,
    uid: number,
  ): Promise<{ id: number; secret_key: string }> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, uid } });
    if (!row) {
      throw new NotFoundException(tr('apikey.not_found', { id }));
    }
    return { id: row.id, secret_key: decrypt(row.secretKey, this.aesKey) };
  }

  /** Create a new key for the user. Both access_key + secret_key are
   *  generated server-side (the frontend sends an empty body). Enforces the
   *  5-key cap. Returns just `{id}`. */
  async create(uid: number): Promise<{ id: number }> {
    const count = await this.prisma.apiKey.count({ where: { uid } });
    if (count >= MAX_KEYS_PER_USER) {
      throw new BadRequestException(
        `Maximum of ${MAX_KEYS_PER_USER} API keys allowed`,
      );
    }
    const accessKey = randomBytes(16).toString('hex');
    const secretKey = randomBytes(32).toString('hex');
    const created = await this.prisma.apiKey.create({
      data: {
        accessKey,
        secretKey: encrypt(secretKey, this.aesKey),
        status: true,
        uid,
      },
    });
    return { id: created.id };
  }

  /** Toggle a key's status. Ownership-scoped (404 if not found OR not owned).
   *  No-op if the status is unchanged. */
  async updateStatus(
    id: number,
    uid: number,
    status: boolean,
  ): Promise<{ success: true }> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, uid } });
    if (!row) {
      throw new NotFoundException(tr('apikey.not_found', { id }));
    }
    if (row.status !== status) {
      await this.prisma.apiKey.update({
        where: { id },
        data: { status },
      });
    }
    return { success: true };
  }

  /** Delete a key. Ownership-scoped (404 if not found OR not owned). */
  async remove(id: number, uid: number): Promise<{ success: true }> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, uid } });
    if (!row) {
      throw new NotFoundException(tr('apikey.not_found', { id }));
    }
    await this.prisma.apiKey.delete({ where: { id } });
    return { success: true };
  }
}
