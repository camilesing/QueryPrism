// appearance.service — the frontend (appearanceStore.setAppearance) calls
// GET /system/appearance/ui on page load (router/watch.ts) BEFORE login to
// load the theme/logo/name. Values are key/value rows in SystemVariable with
// type='appearance' (mirroring the `parameter` module's type='chat'
// convention). Each row maps to the frontend's {pkey, pval} shape.
//
// The admin SAVE is a multipart POST (`data` = JSON array of
// {pkey,pval,ptype,sort} + `files` whose originalname is "<name>,<flag>").
// Uploaded images are stored on disk by AppearanceFileService; the row value
// becomes the opaque file id and GET /system/appearance/picture/:file streams
// it (public — the login page renders before authentication).
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { jsonValueToString } from '../common/utils/json-value';
import { AppearanceFileService } from './appearance-file.service';
import { tr } from '../common/i18n/translate';

export interface AppearancePair {
  pkey: string;
  pval: string;
}

interface AppearanceEntry {
  pkey: string;
  pval: string;
  ptype: string;
  sort: number;
}

/** Keys whose value is an uploaded image id (deleted when replaced/reset). */
const FILE_KEYS = new Set([
  'web',
  'login',
  'bg',
  'navigate',
  'mobileLogin',
  'mobileLoginBg',
]);
const FILE_ID_RE = /^[a-f0-9]{32}\.(png|jpe?g|svg|webp|gif)$/i;

@Injectable()
export class AppearanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: AppearanceFileService,
  ) {}

  /** GET /system/appearance/ui — appearance key/value pairs for the login
   *  page + nav theme. Public (pre-login). Returns [] when none configured. */
  async getUi(): Promise<AppearancePair[]> {
    const rows = await this.prisma.systemVariable.findMany({
      where: { type: 'appearance' },
    });
    return rows.map((row) => ({
      pkey: row.name,
      pval: jsonValueToString(row.value),
    }));
  }

  /** POST /system/appearance — persist KV rows + uploaded images. */
  async save(
    data: string | undefined,
    files: Express.Multer.File[],
  ): Promise<void> {
    const entries = this.parseData(data);
    const pendingFiles = (files ?? []).map((file) => {
      const { flag, fileName } = splitFileFlag(file.originalname);
      if (!FILE_KEYS.has(flag)) {
        throw new BadRequestException(
          `无法识别的外观图片字段: ${fileName || file.originalname}`,
        );
      }
      return { file, flag };
    });

    const names = [
      ...new Set([...entries.keys(), ...pendingFiles.map((f) => f.flag)]),
    ];
    const savedIds: string[] = [];
    let oldFiles: Set<string>;
    try {
      // Reads that decide the writes (conflicts, previous image ids) run in
      // the SAME transaction as the upserts: a variable created between a
      // standalone check and the upsert would otherwise be clobbered.
      oldFiles = await this.prisma.$transaction(async (tx) => {
        // SystemVariable.name is globally unique. Refuse to clobber an
        // unrelated parameter/custom variable sharing an appearance key.
        const conflicts = await tx.systemVariable.findMany({
          where: { name: { in: names }, type: { not: 'appearance' } },
          select: { name: true },
        });
        if (conflicts.length > 0) {
          throw new BadRequestException(
            `变量名已被其他配置占用: ${conflicts.map((c) => c.name).join(', ')}`,
          );
        }
        const existing = new Map(
          (
            await tx.systemVariable.findMany({
              where: { type: 'appearance' },
              select: { name: true, value: true },
            })
          ).map((row) => [row.name, jsonValueToString(row.value)]),
        );

        const stale = new Set<string>();
        for (const { file, flag } of pendingFiles) {
          const fileId = await this.files.save(file);
          savedIds.push(fileId);
          const previous = existing.get(flag) ?? entries.get(flag)?.pval ?? '';
          if (FILE_ID_RE.test(previous)) stale.add(previous);
          entries.set(flag, {
            pkey: flag,
            pval: fileId,
            ptype: 'file',
            sort: 1,
          });
        }

        // Explicit reset of an image field (pval === '') deletes the old file.
        for (const [key, entry] of entries) {
          if (FILE_KEYS.has(key) && entry.pval === '') {
            const previous = existing.get(key) ?? '';
            if (FILE_ID_RE.test(previous)) stale.add(previous);
          }
        }

        for (const entry of entries.values()) {
          if (!entry.pkey) continue;
          const value = entry.pval as Prisma.InputJsonValue;
          await tx.systemVariable.upsert({
            where: { name: entry.pkey },
            create: {
              name: entry.pkey,
              varType: 'text',
              type: 'appearance',
              value,
            },
            update: { varType: 'text', type: 'appearance', value },
          });
        }
        return stale;
      });
    } catch (e) {
      // Rolled back: images written for this save are referenced by nothing.
      await Promise.all(savedIds.map((fileId) => this.files.delete(fileId)));
      throw e;
    }

    await Promise.all([...oldFiles].map((fileId) => this.files.delete(fileId)));
  }

  exists(fileId: string): Promise<boolean> {
    return this.files.exists(fileId);
  }

  pathFor(fileId: string): string {
    return this.files.pathFor(fileId);
  }

  mediaType(fileId: string): string {
    return this.files.mediaType(fileId);
  }

  // --- internals ---------------------------------------------------------

  private parseData(data: string | undefined): Map<string, AppearanceEntry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data ?? '[]');
    } catch {
      throw new BadRequestException(tr('common.invalid_json_string'));
    }
    if (!Array.isArray(parsed)) {
      throw new BadRequestException(tr('appearance.data_must_be_array'));
    }
    const entries = new Map<string, AppearanceEntry>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as {
        pkey?: unknown;
        pval?: unknown;
        ptype?: unknown;
        sort?: unknown;
      };
      if (typeof row.pkey !== 'string' || row.pkey === '') continue;
      entries.set(row.pkey, {
        pkey: row.pkey,
        pval: stringifyValue(row.pval),
        ptype: typeof row.ptype === 'string' ? row.ptype : 'str',
        sort: typeof row.sort === 'number' ? row.sort : 1,
      });
    }
    return entries;
  }
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function splitFileFlag(originalname: string): {
  fileName: string;
  flag: string;
} {
  const idx = originalname.lastIndexOf(',');
  if (idx < 0) return { fileName: originalname, flag: '' };
  return {
    fileName: originalname.slice(0, idx),
    flag: originalname.slice(idx + 1),
  };
}
