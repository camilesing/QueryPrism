// RowPermissionService — runtime row-permission filter resolver. For
// a non-admin user querying a datasource, resolves the matching row-permission
// rules and renders each rule's expressionTree to a per-table WHERE fragment
// via the filter-tree.ts evaluator. The ChatService then feeds these
// fragments to the generateFilter LLM generator (§116 §111 template) which
// merges them into the original SQL, producing a row-filtered SQL.
//
// Design notes:
//  - DsRules has NO `permission_list` column (Phase 10d cycle 5
//    dropped it — the DsPermission.rulesId FK expresses the relationship, so
//    the "rules whose permission_list contains permission.id" check becomes
//    "the permission's parent rules row" (a single FK lookup, not a JSON
//    containment scan). The user-list containment is done in JS (post-filter)
//    rather than via PG JSONB `@>` so it works on SQLite + tolerates the
//    number-or-string dual form of the stored JSON.
//  - the stored expressionTree string is parsed directly with JSON.parse —
//    only its `.tree` field is consumed.
//  - `isNormalUser` = `user.id != 1` (admin hardcoded uid 1; see the
//    license.controller.ts:11 comment).
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import {
  DENY_FRAGMENT,
  transFilterTree,
  type FieldLookup,
  type FieldRef,
  type FilterEvalContext,
  type FilterTree,
  type VariableResolver,
} from './filter-tree';

/** Minimal user shape (structural subset of CurrentUserInfo — only `id` is
 *  consumed; `isNormalUser` checks `id != 1`). */
export interface RowPermissionUser {
  id: number;
}

/** Minimal table shape the service consumes (structural subset of the Prisma
 *  `Table & { fields: Field[] }` returned by DatasourceService.findOne). */
export interface RowPermissionTable {
  id: number;
  tableName: string;
  fields: { id: number; fieldName: string }[];
}

/** Minimal datasource shape the service consumes (structural subset of the
 *  Prisma `Datasource & { tables: { fields }[] }` from findOne). */
export interface RowPermissionDatasource {
  type: string;
  tables: RowPermissionTable[];
}

/** One per-table WHERE fragment to feed the generateFilter LLM generator. */
export interface RowFilter {
  table: string;
  filter: string;
}

@Injectable()
export class RowPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** The admin (uid 1) bypasses row-permission (see the "admin hardcoded
   *  uid 1" note in license.controller.ts:11). */
  isNormalUser(user: RowPermissionUser): boolean {
    return user.id !== 1;
  }

  /** Resolve the matching row-permission rules for `user` querying `ds`, scoped
   *  to the tables the SQL actually references (`tableNames`). Returns one
   *  `{table, filter}` per table that has at least one matching rule whose
   *  expressionTree renders to a non-null WHERE fragment. Empty array for
   *  admin, no matching rules, or empty tableNames. */
  async getRowFilters(
    user: RowPermissionUser,
    ds: RowPermissionDatasource,
    tableNames: string[],
  ): Promise<RowFilter[]> {
    if (!this.isNormalUser(user)) return [];
    if (tableNames.length === 0) return [];

    // Map SQL-referenced table names → Table rows (for ids + field lookups).
    const nameSet = new Set(tableNames);
    const scopedTables = ds.tables.filter((t) => nameSet.has(t.tableName));
    if (scopedTables.length === 0) return [];

    // Fetch all row-type permission rules for these tables, with the parent
    // rules row (to check user-list membership). The FK relationship
    // replaces a permission_list JSONB containment scan.
    const tableIds = scopedTables.map((t) => t.id);
    // Workspace guard: only rule groups owned by the current workspace may
    // affect this query. Fail closed when the request context is missing:
    // the rule set is unknowable, so every referenced table is denied (an
    // empty list would mean "no restriction" — fail open).
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      return scopedTables.map((t) => ({
        table: t.tableName,
        filter: DENY_FRAGMENT,
      }));
    }
    const perms = await this.prisma.dsPermission.findMany({
      where: { tableId: { in: tableIds }, type: 'row', rules: { oid } },
      include: { rules: { select: { userList: true } } },
    });

    // Group matching rules (user ∈ rules.userList) by tableId. Fail-closed:
    // a rule whose expressionTree JSON is corrupt yields a DENY filter for
    // its table (skipping it would silently drop the restriction). A NULL
    // expressionTree is different — no expression was
    // configured, so there is nothing to render and the row stays a no-op.
    const byTable = new Map<number, FilterTree[]>();
    const corruptTables = new Set<number>();
    for (const p of perms) {
      if (!this.userInList(user.id, p.rules?.userList)) continue;
      if (!p.expressionTree) continue;
      if (p.tableId == null) continue; // DsPermission.tableId is Int? — skip orphans
      const tree = this.parseTree(p.expressionTree);
      if (!tree) {
        corruptTables.add(p.tableId);
        continue;
      }
      const list = byTable.get(p.tableId) ?? [];
      list.push(tree);
      byTable.set(p.tableId, list);
    }

    const variableIds = this.collectVariableIds([...byTable.values()].flat());
    const resolveVariable = await this.buildVariableResolver(user, variableIds);

    const out: RowFilter[] = [];
    for (const table of scopedTables) {
      if (corruptTables.has(table.id)) {
        out.push({ table: table.tableName, filter: DENY_FRAGMENT });
        continue;
      }
      const trees = byTable.get(table.id);
      if (!trees || trees.length === 0) continue;
      const fieldLookup = this.buildFieldLookup(table.fields);
      const ctx: FilterEvalContext = {
        fieldLookup,
        ds: { type: ds.type },
        resolveVariable,
      };
      const fragment = transFilterTree(trees, ctx);
      if (fragment) out.push({ table: table.tableName, filter: fragment });
    }
    return out;
  }

  /** Collect every variable_id referenced by the matching trees. */
  private collectVariableIds(trees: FilterTree[]): number[] {
    const ids = new Set<number>();
    const walk = (tree: FilterTree): void => {
      for (const child of tree.items ?? []) {
        if (child.type === 'item') {
          if (
            child.value_type === 'variable' &&
            Number.isInteger(child.variable_id)
          ) {
            ids.add(child.variable_id as number);
          }
        } else if (child.type === 'tree' && child.sub_tree) {
          walk(child.sub_tree);
        }
      }
    };
    trees.forEach(walk);
    return [...ids];
  }

  /** Build the resolver used by filter-tree. System variables map to the
   *  user's name/account/email; custom variables must be bound to the user
   *  (User.systemVariables) and stay within the variable's allowed range.
   *  Anything unresolvable returns null → the item fails CLOSED. */
  private async buildVariableResolver(
    user: RowPermissionUser,
    ids: number[],
  ): Promise<VariableResolver | undefined> {
    if (ids.length === 0) return undefined;
    const [dbUser, variables] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          name: true,
          account: true,
          email: true,
          systemVariables: true,
        },
      }),
      this.prisma.systemVariable.findMany({
        where: { id: { in: ids } },
      }),
    ]);
    const map = new Map<number, string[] | null>();
    for (const variable of variables) {
      map.set(variable.id, this.resolveVariableValues(variable, dbUser));
    }
    return (id: number) => map.get(id) ?? null;
  }

  private resolveVariableValues(
    variable: {
      id: number;
      type: string;
      varType: string;
      value: unknown;
    },
    dbUser: {
      name: string | null;
      account: string;
      email: string | null;
      systemVariables: unknown;
    } | null,
  ): string[] | null {
    if (!dbUser) return null;
    const allowed: unknown[] = Array.isArray(variable.value)
      ? (variable.value as unknown[])
      : [];
    if (variable.type === 'system') {
      const firstAllowed = allowed[0];
      const key =
        typeof firstAllowed === 'string' ? firstAllowed.toLowerCase() : '';
      const value =
        key === 'name'
          ? (dbUser.name ?? dbUser.account)
          : key === 'account'
            ? dbUser.account
            : key === 'email'
              ? dbUser.email
              : null;
      return value != null && String(value).trim() !== ''
        ? [String(value)]
        : null;
    }

    const overrides = Array.isArray(dbUser.systemVariables)
      ? dbUser.systemVariables
      : [];
    const match = overrides.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return (
        Number((entry as { variableId?: unknown }).variableId) === variable.id
      );
    }) as { variableValues?: unknown; variableValue?: unknown } | undefined;
    if (!match) return null;

    const rawValues = Array.isArray(match.variableValues)
      ? match.variableValues
      : match.variableValue != null
        ? [match.variableValue]
        : [];
    let values = rawValues.map((v) => String(v)).filter((v) => v.trim() !== '');
    if (values.length === 0) return null;

    if (variable.varType === 'text') {
      const set = new Set(
        allowed.filter((v): v is string => typeof v === 'string'),
      );
      values = values.filter((v) => set.has(v));
    } else if (
      variable.varType === 'number' ||
      variable.varType === 'datetime'
    ) {
      const kind = variable.varType === 'number' ? 'number' : 'datetime';
      const first = numberBound(values[0], kind);
      const min = numberBound(allowed[0], kind);
      const max = numberBound(allowed[1], kind);
      if (first != null) {
        if (min != null && first < min) return null;
        if (max != null && first > max) return null;
      }
    }
    // kv: User.systemVariables already stores the resolved value(s).
    return values.length > 0 ? values : null;
  }

  /** Check user membership in a stored userList JSON array. Tolerates a
   *  number-or-string dual form (DsRules.userList is Json?, so
   *  the array may hold numbers or strings depending on the admin save path).
   *  Null/empty/non-array → false. */
  private userInList(userId: number, userList: unknown): boolean {
    if (!Array.isArray(userList) || userList.length === 0) return false;
    const idNum = userId;
    const idStr = String(userId);
    return userList.some((v) => v === idNum || v === idStr);
  }

  /** Parse the stored expressionTree JSON string into a FilterTree. Returns
   *  null on parse failure or a non-object — the CALLER then fails CLOSED
   *  (§116.6b: a corrupt rule denies its table; only a valid tree or a
   *  never-configured NULL expressionTree yields no filter). */
  private parseTree(raw: string): FilterTree | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!('logic' in parsed) || !('items' in parsed)) return null;
      return parsed as FilterTree;
    } catch {
      return null;
    }
  }

  /** Build a FieldLookup callback backed by a flat field list (one table's
   *  fields). Fields not found return null → transTreeItem skips the item. */
  private buildFieldLookup(
    fields: { id: number; fieldName: string }[],
  ): FieldLookup {
    const map = new Map<number, FieldRef>(
      fields.map((f) => [f.id, { fieldName: f.fieldName }]),
    );
    return (id: number) => map.get(id) ?? null;
  }
}

/** Parse a number/datetime bound from the loose Json variable value. Only
 *  primitives are accepted — an object/array bound is treated as unset. */
function numberBound(
  value: unknown,
  kind: 'number' | 'datetime',
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = kind === 'number' ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
