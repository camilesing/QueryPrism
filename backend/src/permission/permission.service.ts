// permission.service — Phase 10d cycle 5. Implements the 3-route contract
// (list/save/delete) reverse-engineered from the frontend, which is the
// source of truth, so the contract below is authoritative.
//
// 3 routes (all POST, all under /ds_permission/ prefix — RESTful bare verbs,
// NOT action-style POST verbs like dashboard §107):
//   - POST /list      → bare array of rule groups (TransformInterceptor wraps;
//                        frontend unwraps outer data → bare array)
//   - POST /save      → body {id?, name, permissions:[item], users:[uid]};
//                        absent id = create, present = update (delete-all-
//                        recreate items). Frontend only checks promise resolution.
//   - POST /delete/:id → path param (rule-group id); frontend only checks
//                        promise resolution.
//
// Data model (NEW — Phase 8 had no permission concept):
//   - DsRules (rule group): id/oid/name/userList(Json number[])/createTime/updatedAt
//   - DsPermission (item): id/rulesId(FK onDelete:Cascade)/name/type/dsId/dsName/
//                          tableId/tableName/expressionTree(String? JSON)/
//                          permissions(String? JSON)/createTime/updatedAt
//
// `expressionTree` + `permissions` are stored as String? (Text, JSON string as-is)
// — the save body sends them as JSON strings (frontend JSON.stringify's before
// send). On list read, the snake-mapper parses them back to `tree` (object) +
// `permission_list` (array). No Prisma.JsonNull needed (Text columns accept
// plain null). The `permission_list:[]` field in the save body is an in-memory
// alias that's always empty on save — the backend ignores it (derives nothing
// from it; the rule group's permissions array comes from the DsPermission
// relation via the FK, not from a stored permission_list column).
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { FILTER_TERMS } from './filter-tree';
import {
  toPermissionGroupSnake,
  type PermissionGroupSnake,
} from './permission-snake-mapper';
import { tr } from '../common/i18n/translate';

/** The save body shape the frontend sends (snake_case, §101 ValidationPipe
 *  passthrough — no DTO class). `id` is omitted on create, present on update.
 *  `permission_list` is always `[]` on save (in-memory alias dropped). */
export interface PermissionSaveBody {
  id?: number;
  name: string;
  // both optional on the wire (SavePermissionDto @IsOptional); save() defaults them to []
  permissions?: PermissionSaveItem[];
  users?: number[];
}

/** One item in the save body's `permissions` array. The frontend spreads all
 *  in-memory fields + JSON-stringifies `permissions` (column field list) +
 *  `expression_tree` (row tree). `permission_list` is always `[]`. */
export interface PermissionSaveItem {
  id?: number; // client-side id (+new Date() for new items); ignored on save
  name?: string;
  type: string; // 'row' | 'column'
  ds_id?: number | null;
  ds_name?: string | null;
  table_id?: number | null;
  table_name?: string | null;
  permissions?: string; // JSON string (column field list); row sends '[]'
  expression_tree?: string; // JSON string (row tree); column sends '{}'
  permission_list?: unknown[]; // always [] on save; ignored
}

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** POST /ds_permission/list → bare array of snake-mapped rule groups
   *  (oid-scoped, includes the DsPermission relation). The frontend reads
   *  `res` directly as the array (ruleList.value = res || []). */
  async list(): Promise<PermissionGroupSnake[]> {
    const oid = this.currentOid();
    const rules = await this.prisma.dsRules.findMany({
      where: { oid },
      include: { permissions: true },
      orderBy: { createTime: 'desc' },
    });
    return rules.map((r) => toPermissionGroupSnake(r));
  }

  /** POST /ds_permission/save → upsert (absent id = create, present = update).
   *  Update path is delete-all-recreate: delete old DsPermission rows for this
   *  rules_id, then update the DsRules row, then create new DsPermission rows.
   *  Both paths run inside ONE $transaction (2026-09 review P1-1: a
   *  mid-sequence failure used to permanently destroy the group's rules —
   *  deleteMany succeeded, update/createItems never ran). Avoids complex
   *  diff logic; the frontend re-fetches the list after save so item id churn
   *  is invisible. Returns {id, name} for the @SystemLog resources callback
   *  (§94 post-await pre-envelope). */
  async save(body: PermissionSaveBody): Promise<{ id: number; name: string }> {
    const name = (body.name ?? '').trim();
    if (!name) {
      throw new BadRequestException(tr('permission.group_name_required'));
    }
    const oid = this.currentOid();
    const userList = this.jsonUserList(body.users ?? []);
    // §116.6b companion: reject unrenderable expression trees BEFORE any
    // write — a rule the evaluator would have to deny is a configuration
    // error the admin must fix at save time (and validating first keeps the
    // delete-all-recreate update path from half-applying).
    (body.permissions ?? []).forEach((it, i) =>
      this.validateExpressionTree(it, i),
    );

    if (body.id == null) {
      // create — rules row + items in one transaction.
      return this.prisma.$transaction(async (tx) => {
        await this.validateDatasourceRefs(tx, body.permissions ?? []);
        const created = await tx.dsRules.create({
          data: { oid, name, userList },
        });
        await this.createItems(created.id, body.permissions ?? [], tx);
        return { id: created.id, name };
      });
    }

    // update — ownership check, then delete-all-recreate items + update
    // rules atomically.
    await this.findOneOrFail(body.id);
    return this.prisma.$transaction(async (tx) => {
      await this.validateDatasourceRefs(tx, body.permissions ?? []);
      await tx.dsPermission.deleteMany({ where: { rulesId: body.id! } });
      await tx.dsRules.update({
        where: { id: body.id! },
        data: { name, userList },
      });
      await this.createItems(body.id!, body.permissions ?? [], tx);
      return { id: body.id!, name };
    });
  }

  /** POST /ds_permission/delete/:id → delete the rule group + cascade its
   *  items (explicit deleteMany keeps the cascade observable/auditable), in one
   *  transaction. Returns [{id}] for the @SystemLog DELETE resources callback. */
  async remove(id: number): Promise<{ id: number }[]> {
    const oid = this.currentOid();
    const row = await this.prisma.dsRules.findFirst({
      where: { id, oid },
    });
    if (!row) {
      throw new NotFoundException(tr('permission.group_not_found', { id }));
    }
    await this.prisma.$transaction([
      this.prisma.dsPermission.deleteMany({ where: { rulesId: id } }),
      this.prisma.dsRules.delete({ where: { id } }),
    ]);
    return [{ id }];
  }

  // ─────────────────────────── private helpers ───────────────────────────

  /** Save-time validation of a row-type item's expression_tree (§116.6b
   *  companion to the evaluator's fail-closed rendering): reject what cannot
   *  render safely — unparseable JSON, bad tree shape, variable items without
   *  a variable_id, unknown terms, malformed between operands, empty enums.
   *  Column items carry '{}' — nothing to validate. */
  private validateExpressionTree(
    item: PermissionSaveItem,
    index: number,
  ): void {
    if (item.type !== 'row') return;
    const raw = item.expression_tree;
    if (raw == null || raw === '') return; // no expression configured — allowed
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        `权限项 #${index + 1} 的表达式不是合法 JSON`,
      );
    }
    this.validateTreeNode(parsed, index);
  }

  /** Recursive shape check of one tree node (item or sub_tree). */
  private validateTreeNode(node: unknown, index: number): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new BadRequestException(
        tr('permission.item_invalid_structure', { n: index + 1 }),
      );
    }
    const n = node as {
      logic?: unknown;
      items?: unknown;
    };
    const logic = typeof n.logic === 'string' ? n.logic.toUpperCase() : '';
    if (logic !== 'AND' && logic !== 'OR') {
      throw new BadRequestException(
        `权限项 #${index + 1} 的逻辑运算符必须是 AND 或 OR`,
      );
    }
    if (!Array.isArray(n.items)) {
      throw new BadRequestException(
        tr('permission.item_missing_items', { n: index + 1 }),
      );
    }
    for (const child of n.items) {
      const c = child as {
        type?: unknown;
        sub_tree?: unknown;
        term?: unknown;
        value_type?: unknown;
        value?: unknown;
        filter_type?: unknown;
        enum_value?: unknown;
        variable_id?: unknown;
      };
      if (c && c.type === 'tree') {
        this.validateTreeNode(c.sub_tree, index);
        continue;
      }
      const isVariable = c?.value_type === 'variable';
      if (isVariable) {
        const variableId = Number(c.variable_id);
        if (!Number.isInteger(variableId) || variableId <= 0) {
          throw new BadRequestException(
            `权限项 #${index + 1} 的变量条件缺少有效的 variable_id`,
          );
        }
      }
      if (typeof c?.term !== 'string' || !FILTER_TERMS.has(c.term)) {
        throw new BadRequestException(
          tr('permission.item_unknown_operator', { n: index + 1 }),
        );
      }
      // Variable values are supplied per user at runtime; the stored `value`
      // is unused, so the between/enum value checks below do not apply.
      if (isVariable) continue;
      if (c.term === 'between') {
        const valueStr = typeof c.value === 'string' ? c.value : '';
        const parts = valueStr.split(',');
        if (parts.length !== 2 || parts.some((p) => p.trim() === '')) {
          throw new BadRequestException(
            `权限项 #${index + 1} 的 between 条件需要恰好两个操作数`,
          );
        }
      }
      if (
        c.filter_type === 'enum' &&
        (!Array.isArray(c.enum_value) || c.enum_value.length === 0)
      ) {
        throw new BadRequestException(
          `权限项 #${index + 1} 的枚举条件缺少取值`,
        );
      }
    }
  }

  /** Create DsPermission rows for each item in the save body's `permissions`
   *  array. The client-side `id` is ignored (regenerated via autoincrement);
   *  `permission_list` is ignored (always [] on save). `expressionTree` +
   *  `permissions` are stored as raw JSON strings (no parsing on save).
   *  P3-2: ONE createMany instead of N sequential row inserts (runs on the
   *  caller's client — the transactional client inside save(), or the plain
   *  PrismaService default). */
  private async createItems(
    rulesId: number,
    items: PermissionSaveItem[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (items.length === 0) return;
    await client.dsPermission.createMany({
      data: items.map((it) => ({
        rulesId,
        name: it.name ?? null,
        type: it.type,
        dsId: it.ds_id ?? null,
        dsName: it.ds_name ?? null,
        tableId: it.table_id ?? null,
        tableName: it.table_name ?? null,
        expressionTree: it.expression_tree ?? null,
        permissions: it.permissions ?? null,
      })),
    });
  }

  /** Zone isolation: a permission item may only reference datasources/tables
   *  owned by the current workspace. Runs inside the save transaction so a
   *  concurrent delete cannot slip between the check and the insert. */
  private async validateDatasourceRefs(
    client: Prisma.TransactionClient,
    items: PermissionSaveItem[],
  ): Promise<void> {
    const oid = this.currentOid();
    const dsIds = [
      ...new Set(
        items
          .map((i) => i.ds_id)
          .filter((v): v is number => typeof v === 'number'),
      ),
    ];
    if (dsIds.length > 0) {
      const found = await client.datasource.count({
        where: { id: { in: dsIds }, oid },
      });
      if (found !== dsIds.length) {
        throw new BadRequestException(
          '权限项引用的数据源不存在或不属于当前工作空间',
        );
      }
    }
    const tableIds = [
      ...new Set(
        items
          .map((i) => i.table_id)
          .filter((v): v is number => typeof v === 'number'),
      ),
    ];
    if (tableIds.length > 0) {
      const found = await client.table.count({
        where: { id: { in: tableIds }, datasource: { oid } },
      });
      if (found !== tableIds.length) {
        throw new BadRequestException(
          '权限项引用的表不存在或不属于当前工作空间',
        );
      }
    }
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new NotFoundException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private async findOneOrFail(id: number) {
    const oid = this.currentOid();
    const row = await this.prisma.dsRules.findFirst({ where: { id, oid } });
    if (!row) {
      throw new NotFoundException(tr('permission.group_not_found', { id }));
    }
    return row;
  }

  /** Prisma Json columns can't store a plain `null` — map empty to JsonNull
   *  so a missing user list persists as SQL NULL (§88 JsonNull-sentinel pattern). */
  private jsonUserList(
    users: number[],
  ): Prisma.NullableJsonNullValueInput | number[] {
    return users.length === 0 ? Prisma.JsonNull : users;
  }
}
