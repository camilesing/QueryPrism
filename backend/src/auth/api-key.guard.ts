// ApiKeyGuard — authenticates EXTERNAL machine-to-machine writes (the
// MetaDataImprove M2 meta import API) with a per-user ApiKey pair:
//   X-QUERYPRISM-APIKEY:   <accessKey>   (public lookup key)
//   X-QUERYPRISM-APISECRET: <secret>     (compared timing-safe against the
//                                         AES-decrypted stored secret)
// The FIRST consumer of the ApiKey module (it existed with no guard before).
// On success the owner's user row is re-read from the DB (account disabling
// and workspace membership take effect immediately) and attached to
// req.user + the ALS context, so downstream services see a normal
// CurrentUserInfo (currentOid() / weight checks all work).
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import {
  requestContextStorage,
  type CurrentUserInfo,
} from '../common/context/request-context';
import { tr } from '../common/i18n/translate';
import { decrypt } from '../common/utils/aes';
import { PrismaService } from '../database/prisma.service';
import { ADMIN_UID } from './admin.guard';

export const APIKEY_HEADER = 'X-QUERYPRISM-APIKEY';
export const APISECRET_HEADER = 'X-QUERYPRISM-APISECRET';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserInfo }>();
    const accessKey = req.header(APIKEY_HEADER) ?? null;
    const presented = req.header(APISECRET_HEADER) ?? null;
    if (!accessKey || !presented) {
      throw new UnauthorizedException(tr('apikey.missing_headers'));
    }

    const row = await this.prisma.apiKey.findUnique({
      where: { accessKey },
      select: { secretKey: true, status: true, uid: true },
    });
    if (!row || !row.status) {
      throw new UnauthorizedException(tr('apikey.invalid'));
    }
    let expected: string;
    try {
      expected = decrypt(row.secretKey, this.config.get<string>('aes.key')!);
    } catch {
      throw new UnauthorizedException(tr('apikey.invalid'));
    }
    const presentedBuf = Buffer.from(presented, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (
      presentedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(presentedBuf, expectedBuf)
    ) {
      throw new UnauthorizedException(tr('apikey.invalid'));
    }

    // DB-authoritative user snapshot (mirror JwtAuthGuard's re-read).
    const user = await this.prisma.user.findUnique({
      where: { id: row.uid },
      select: {
        id: true,
        account: true,
        language: true,
        oid: true,
        status: true,
        userWorkspaces: {
          select: {
            oid: true,
            weight: true,
            workspace: { select: { archivedAt: true } },
          },
        },
      },
    });
    if (!user || user.status !== 1) {
      throw new UnauthorizedException(tr('apikey.invalid'));
    }
    // Mirror JwtAuthGuard: uid 1 may enter any existing workspace without a
    // UserWs row; everyone else needs a membership in a non-archived one.
    let weight = 0;
    if (user.id === ADMIN_UID) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: user.oid },
        select: { id: true },
      });
      if (!workspace) throw new UnauthorizedException(tr('apikey.invalid'));
    } else {
      const membership = user.userWorkspaces.find((m) => m.oid === user.oid);
      if (!membership || membership.workspace.archivedAt != null) {
        throw new UnauthorizedException(tr('apikey.invalid'));
      }
      weight = membership.weight;
    }
    const current: CurrentUserInfo = {
      id: user.id,
      account: user.account,
      oid: user.oid,
      language: user.language,
      weight,
    };
    req.user = current;
    const store = requestContextStorage.getStore();
    if (store) store.user = current;
    return true;
  }
}
