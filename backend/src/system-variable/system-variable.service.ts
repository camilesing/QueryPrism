// system-variable.service — Phase 10c cycle 2 §82/§88/§101. Aligned to the
// `sys_variable` contract. The frontend
// (variables/index.vue + RowAuth/FilterFiled permission) is the source of
// truth; this service adapts to it.
//
// Contract notes (reverse-engineered from the frontend):
//   - 4 action-style POST routes (NOT GET/PUT/DELETE) — the variable API
//     is all POST. `save`/`delete`/`listAll`/`listPage` are action verbs.
//   - `save` (create OR update by id presence): server forces `type='custom'`
//     on create (system vars can't be created/edited via this route — they're
//     seeded); sets `createTime`/`createBy` on create only. Name uniqueness
//     check (400 on conflict — semantically correct for a client-input
//     conflict; the frontend handles 400 or 500 alike).
//   - `listAll`: no name → ALL ordered by `type desc, name asc` (system vars
//     sort first since 'system' > 'custom' lexically); with name →
//     `name contains kw AND type != 'system'` (system vars excluded from
//     name searches). Returns bare array.
//   - `listPage`: same filter, paginated → `{items, total}`.
//   - `delete`: bare array `ids` → `deleteMany where id in ids`. No type check
//     (frontend variables/index.vue:33 hardcodes
//     `![1,2,3].includes(row.id)` as non-selectable + :90 early-returns on
//     `row.type === 'system'` — client-side prevention of system-var deletion).
//   - `value` is ALWAYS a Json array (text=string[], number=[min,max],
//     datetime=[start,end]). Stored as Prisma Json, passes through verbatim.
//   - `var_type` (snake on the wire) ↔ `varType` (Prisma camelCase column).
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { parseStrictInt } from '../common/utils/parse-int';
import {
  toSysVariableSnake,
  type SysVariableSnake,
} from './sys-variable-snake-mapper';
import { tr } from '../common/i18n/translate';

/** Plain typed save body (no DTO class — ValidationPipe passthrough, §101).
 *  The frontend (variables/index.vue:236-256) sends `{name, var_type, value}`
 *  on create (id deleted when falsy) or `{id, name, var_type, value}` on
 *  update. `id` may arrive as string|number; coerced via Number(). */
export interface SysVariableSaveBody {
  id?: string | number | null;
  name: string;
  var_type: string;
  value: unknown[]; // always an array (text/number/datetime)
}

@Injectable()
export class SystemVariableService {
  constructor(private readonly prisma: PrismaService) {}

  /** P3-3: the listAll/listPage filter + sort, shared (was duplicated
   *  verbatim in both — destined to drift). No name → all (system + custom);
   *  with name → `name contains kw AND type != system` (system vars excluded
   *  from name searches; the filter is a case-insensitive contains). */
  private listFilter(name?: string): {
    where: Prisma.SystemVariableWhereInput;
    orderBy: Prisma.SystemVariableOrderByWithRelationInput[];
  } {
    return {
      where: name
        ? {
            name: { contains: name, mode: 'insensitive' },
            type: { not: 'system' },
          }
        : {},
      orderBy: [{ type: 'desc' }, { name: 'asc' }],
    };
  }

  /** listAll — bare array. */
  async listAll(name?: string): Promise<SysVariableSnake[]> {
    const { where, orderBy } = this.listFilter(name);
    const rows = await this.prisma.systemVariable.findMany({
      where,
      orderBy,
    });
    return rows.map(toSysVariableSnake);
  }

  /** listPage — `{items, total}` envelope. Same filter as listAll. */
  async listPage(
    pageNum: number,
    pageSize: number,
    name?: string,
  ): Promise<{ items: SysVariableSnake[]; total: number }> {
    const { where, orderBy } = this.listFilter(name);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.systemVariable.count({ where }),
      this.prisma.systemVariable.findMany({
        where,
        orderBy,
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: rows.map(toSysVariableSnake), total };
  }

  /** save — upsert by id presence. Server forces `type='custom'` on create
   *  (system vars are seeded, not user-editable). Name uniqueness check → 400
   *  on conflict (excluding self on update). Review P1-1: the dup check and
   *  the write run in ONE $transaction — the old check-then-write raced two
   *  concurrent same-name saves past the check (name IS @unique, so the
   *  loser surfaced as an opaque unique-constraint 500 instead of the 400). */
  async save(
    body: SysVariableSaveBody,
    uid: number,
  ): Promise<{ success: true }> {
    // P2-1: strict parse — a non-numeric id ("abc") used to become NaN,
    // which every `!idNum`/`idNum ?` check treated as falsy → the request
    // silently fell into the CREATE branch and inserted a NEW row. An id
    // that is present-but-unparseable is a client error → 400.
    let idNum: number | undefined;
    if (body.id !== undefined && body.id !== null && body.id !== '') {
      const parsed = parseStrictInt(body.id);
      if (parsed === null) {
        throw new BadRequestException(tr('system-variable.id_must_be_int'));
      }
      idNum = parsed;
    }
    // Name uniqueness check (excluding self on update).
    const dupWhere: Prisma.SystemVariableWhereInput = idNum
      ? { name: body.name, id: { not: idNum } }
      : { name: body.name };
    await this.prisma.$transaction(async (tx) => {
      const dup = await tx.systemVariable.findFirst({
        where: dupWhere,
      });
      if (dup) {
        throw new BadRequestException(tr('system-variable.name_exists'));
      }
      if (!idNum) {
        await tx.systemVariable.create({
          data: {
            name: body.name,
            varType: body.var_type,
            type: 'custom',
            value: body.value as Prisma.InputJsonValue,
            createTime: new Date(),
            createBy: uid,
          },
        });
      } else {
        await tx.systemVariable.update({
          where: { id: idNum },
          data: {
            name: body.name,
            varType: body.var_type,
            value: body.value as Prisma.InputJsonValue,
          },
        });
      }
    });
    return { success: true };
  }

  /** delete — bare array of ids. No type check (frontend prevents system-var
   *  deletion client-side). */
  async delete(ids: number[]): Promise<{ success: true }> {
    const idNums = ids.map(Number);
    if (idNums.length > 0) {
      await this.prisma.systemVariable.deleteMany({
        where: { id: { in: idNums } },
      });
    }
    return { success: true };
  }
}
