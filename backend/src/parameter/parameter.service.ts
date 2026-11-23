// parameter.service — reconciles the parameter module to the frontend's
// contract. The frontend consumes every
// /system/parameter/* GET as a list of {pkey, pval} pairs:
//   - GET /system/parameter/login (Handler.vue:385, pre-login, public) reads
//     login.default_login to pick the default SSO provider (0 → local login).
//   - GET /system/parameter/chat (chatConfig.ts:48, post-login) reads chat.*
//     UI flags (show_sql, hide_thinking_block, limit_rows, queryprism_name, …).
//   - GET /system/parameter (parameter/index.vue:22, admin) returns all params;
//     the page filters client-side by pkey prefix (chat/login/platform).
//   - POST /system/parameter (parameter/index.vue:84, admin save) sends a
//     multipart form whose `data` text field is a JSON string of
//     [{pkey, pval}].
//
// Storage reuses SystemVariable with type='parameter' (distinct from
// appearance type='appearance' and sys_variable type='system'|'custom'). The
// group IS the pkey prefix (login.*, chat.*, platform.*) — same convention the
// frontend admin page uses to bucket rows. Each row stores name=pkey,
// varType='str' (parameter pvals are always strings on the wire), value=pval;
// reads coerce Json scalars with jsonValueToString() to keep the pval:string
// contract (never '[object Object]').
// name is @unique, so save upserts by where:{name}. No existing type='chat'
// data (only 3 type='system' built-ins), so the type change needs no migration.
//
// parseParameterItems is a pure helper (no DI) so the controller can unit-test
// the multipart `data` field parsing without standing up Express/multer.
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { jsonValueToString } from '../common/utils/json-value';
import {
  EMBEDDING_PARAMETER_KEYS,
  embeddingFieldOfKey,
  parseEmbeddingParameter,
  resolveEmbeddingConfig,
} from '../common/config/embedding-config';
import { EmbeddingBackfillService } from '../embedding/embedding-backfill.service';

/** A single parameter key/value pair in the frontend's {pkey, pval} shape. */
export interface ParameterItem {
  pkey: string;
  pval: string;
}

/**
 * Parse + validate the multipart `data` field (a JSON string of [{pkey, pval}])
 * posted by the admin parameter page. Pure (no DI) so it can be unit-tested in
 * isolation. Throws BadRequestException on any shape violation.
 */
export function parseParameterItems(
  dataJson: string | undefined,
): ParameterItem[] {
  if (!dataJson) {
    throw new BadRequestException('parameter data field is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    throw new BadRequestException('parameter data is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException('parameter data must be an array');
  }
  return parsed.map((raw: unknown, index: number) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof (raw as { pkey?: unknown }).pkey !== 'string' ||
      typeof (raw as { pval?: unknown }).pval !== 'string'
    ) {
      throw new BadRequestException(
        `parameter item ${index} must have string pkey and pval`,
      );
    }
    const item = raw as { pkey: string; pval: string };
    return { pkey: item.pkey, pval: item.pval };
  });
}

/** P3-3: the {pkey, pval} row mapper used to be copy-pasted at three call
 *  sites (getGroup/getAll/save) — one helper now. */
function toParameterItems(
  rows: { name: string; value: Prisma.JsonValue }[],
): ParameterItem[] {
  return rows.map((row) => ({
    pkey: row.name,
    pval: jsonValueToString(row.value),
  }));
}

@Injectable()
export class ParameterService {
  private readonly logger = new Logger(ParameterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingBackfill: EmbeddingBackfillService,
  ) {}

  /** GET /system/parameter/<group> — rows whose pkey starts with the group
   *  prefix + '.' (e.g. 'login' → login.*). The trailing dot matters:
   *  without it, group 'abc' would also match 'abcd.*' rows (2026-09 review
   *  QW3). */
  async getGroup(group: string): Promise<ParameterItem[]> {
    const rows = await this.prisma.systemVariable.findMany({
      where: {
        type: 'parameter',
        name: { startsWith: `${group}.`, mode: 'insensitive' },
      },
    });
    return toParameterItems(rows);
  }

  /** GET /system/parameter — all parameter rows mapped to {pkey, pval}.
   *  9e6070e8: embedding.* rows unsaved in the store are appended at their
   *  backend-resolved EFFECTIVE value (saved > env > default) so the page
   *  never paints a frontend default over deployment config. */
  async getAll(): Promise<ParameterItem[]> {
    const rows = await this.prisma.systemVariable.findMany({
      where: { type: 'parameter' },
    });
    const items = toParameterItems(rows);
    const saved = new Set(items.map((i) => i.pkey));
    const cfg = await resolveEmbeddingConfig(this.prisma);
    for (const key of EMBEDDING_PARAMETER_KEYS) {
      if (saved.has(key)) continue;
      const field = embeddingFieldOfKey(key);
      if (field == null) continue;
      items.push({
        pkey: key,
        pval: String((cfg as unknown as Record<string, unknown>)[field]),
      });
    }
    return items;
  }

  /** POST /system/parameter — upsert each {pkey, pval} (name=pkey,
   *  type='parameter', varType='str', value=pval), then return the full set
   *  mapped to {pkey, pval}. P3-2: ONE createMany for new keys + per-key
   *  updates for existing keys (updateMany can't set per-row values) instead
   *  of N sequential upserts; within-request duplicate pkeys take the LAST
   *  value (matching sequential-upsert semantics).
   *  9e6070e8: embedding.* items are strict-validated BEFORE the transaction —
   *  one invalid row rejects the whole save (no partial writes, no clamping). */
  async save(items: ParameterItem[]): Promise<ParameterItem[]> {
    for (const item of items) {
      const field = embeddingFieldOfKey(item.pkey);
      if (field == null) continue;
      try {
        parseEmbeddingParameter(field, item.pval);
      } catch (e) {
        throw new BadRequestException(
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    // 9e6070e8 lifecycle: re-enabling a disabled embedding half must backfill
    // the rows whose embedding stayed NULL while it was off. Snapshot the
    // config before/after the save; a false→true flip fires the matching
    // backfill fire-and-forget (never blocks the save response). Table and
    // metric recall each keep their own switch.
    const previous = await resolveEmbeddingConfig(this.prisma);
    const result = await this.prisma.$transaction(async (tx) => {
      const byKey = new Map(items.map((i) => [i.pkey, i.pval] as const));
      const unique = [...byKey].map(([pkey, pval]) => ({ pkey, pval }));
      const existing = await tx.systemVariable.findMany({
        where: { name: { in: unique.map((i) => i.pkey) } },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((e) => e.name));
      const toCreate = unique.filter((i) => !existingNames.has(i.pkey));
      const toUpdate = unique.filter((i) => existingNames.has(i.pkey));
      if (toCreate.length > 0) {
        await tx.systemVariable.createMany({
          data: toCreate.map((i) => ({
            name: i.pkey,
            type: 'parameter',
            varType: 'str',
            value: i.pval,
          })),
        });
      }
      for (const i of toUpdate) {
        await tx.systemVariable.update({
          where: { name: i.pkey },
          data: { value: i.pval },
        });
      }
      const rows = await tx.systemVariable.findMany({
        where: { type: 'parameter' },
      });
      return toParameterItems(rows);
    });
    const current = await resolveEmbeddingConfig(this.prisma);
    if (!previous.tableEnabled && current.tableEnabled) {
      void this.embeddingBackfill
        .runTablesAndDatasources()
        .catch((e) =>
          this.logger.error(
            `table/datasource backfill after embedding.table_enabled re-enable failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
    }
    if (!previous.metricEnabled && current.metricEnabled) {
      void this.embeddingBackfill
        .runMetrics()
        .catch((e) =>
          this.logger.error(
            `metric backfill after metric.enabled re-enable failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          ),
        );
    }
    return result;
  }
}
