// filter-tree — pure string-building evaluator: a row-permission expression
// tree → a safe SQL WHERE fragment.
// No DI, no NestJS deps — trivially importable (RowPermissionService injects
// a Prisma-backed FieldLookup; tests inject a plain map).
//
// Design notes (documented in implementation-decisions.md):
//  1. No `sqlServer + nchar/nvarchar` special case (the supported engines
//     are MySQL/PostgreSQL/SQLite — no sqlServer, so the N'...' unicode-
//     prefix path is dead code). Engine quoting is a single
//     quoteIdentifier() helper instead of a per-engine prefix/suffix pair.
//  2. `value_type === 'variable'` is supported through the ctx.resolveVariable
//     callback (system name/account/email + user-bound custom variables).
//     An unresolvable variable fails CLOSED (never silently skipped).
//  3. Engine quoting: MySQL → backtick (`), PostgreSQL/SQLite → double-quote
//     ("), unknown → double-quote (default).
//  4. `between` term: the comma-separated value is split into the two
//     operands the frontend intends, and rendering denies when there
//     aren't exactly two.
//  5. `current_user` is collapsed into ctx.resolveVariable (the only consumer
//     was the variable branch).
//  6. SECURITY hardening (2026-09 review, P0-1) — the evaluator must be
//     neither injectable nor privilege-widening:
//     (a) quoteIdentifier DOUBLES embedded quote chars — a fieldName
//         containing `"` or a backtick cannot break out of the identifier;
//     (b) fail CLOSED — items that exist but cannot render safely (unknown
//         field, unresolvable variable, empty enum, malformed between)
//         contribute the DENY_FRAGMENT instead of silently vanishing (a
//         skipped item would drop the restriction = widen access);
//     (c) the enum branch honours `term` (`not in` → NOT IN, not inverted
//         to IN);
//     (d) LIKE values escape `%`/`_`/quotes/backslash + an explicit ESCAPE
//         clause (value wildcards must match literally, not act as
//         wildcards);
//     (e) backslash doubling in literals is MySQL-only (PG default + SQLite
//         treat `\` literally — doubling there corrupts values).

// --- types ----------------------------------------------------------------

export type FilterLogicOp = 'AND' | 'OR';

/** Every recognised term string. Note `not in` / `not like` use SPACES
 *  (not underscores) — the stored expressionTree data matches these
 *  literals. */
export type FilterTerm =
  | 'eq'
  | 'not_eq'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'in'
  | 'not in'
  | 'like'
  | 'not like'
  | 'null'
  | 'not_null'
  | 'empty'
  | 'not_empty'
  | 'between';

/** A leaf condition (field op value). `value` is the literal string the admin
 *  entered; for `in`/`not in` it is comma-separated. `enum_value` is the
 *  multi-select list when `filter_type === 'enum'`. */
export interface FilterTreeItem {
  type: 'item';
  field_id: number;
  term: FilterTerm;
  filter_type?: string; // 'enum' | undefined
  enum_value?: string[];
  value_type?: string; // 'variable' → value comes from resolveVariable
  variable_id?: number;
  value?: string;
}

/** A subtree child — recurses into `sub_tree` (a full FilterTree). */
export interface FilterTreeNode {
  type: 'tree';
  logic?: FilterLogicOp; // unused on the node itself (sub_tree carries it)
  sub_tree: FilterTree;
}

export type FilterTreeChild = FilterTreeItem | FilterTreeNode;

/** A single expression tree: a logic op joining its `items`. One
 *  DsPermission.expressionTree parses to one of these. */
export interface FilterTree {
  logic: FilterLogicOp;
  items: FilterTreeChild[];
}

export interface FieldRef {
  fieldName: string;
}

/** Field lookup callback — the caller provides this (Prisma-backed in prod,
 *  a plain map in tests). Returns null when the field id is unknown (the
 *  evaluator then renders the item as DENY_FRAGMENT — fail closed, so the
 *  restriction is never silently dropped). */
export type FieldLookup = (fieldId: number) => FieldRef | null;

/** Resolve a system/custom variable to its value list for the current user.
 *  null/[] means "cannot resolve" → the item fails CLOSED (DENY). */
export type VariableResolver = (variableId: number) => string[] | null;

export interface DatasourceContext {
  type: string; // 'mysql' | 'postgresql' | 'sqlite' | ...
}

/** Everything the evaluator needs beyond the tree itself — field lookup,
 *  datasource engine type, and variable resolution for the current user. */
export interface FilterEvalContext {
  fieldLookup: FieldLookup;
  ds: DatasourceContext;
  /** Required when a tree contains value_type='variable'; absent → DENY. */
  resolveVariable?: VariableResolver;
}

// --- helpers --------------------------------------------------------------

/** Runtime whitelist of every term transFilterTerm recognises — used by the
 *  save-time validation in permission.service (second line of defence after
 *  transFilterTerm's empty-string fallback for unknown terms). */
export const FILTER_TERMS: ReadonlySet<string> = new Set([
  'eq',
  'not_eq',
  'lt',
  'le',
  'gt',
  'ge',
  'in',
  'not in',
  'like',
  'not like',
  'null',
  'not_null',
  'empty',
  'not_empty',
  'between',
]);

/** A WHERE fragment that matches no rows. Emitted when a configured rule
 *  cannot be rendered safely (unknown field id, unresolvable variable,
 *  empty enum, malformed between) — fail CLOSED: an unrenderable
 *  restriction must deny access, not silently widen it. */
export const DENY_FRAGMENT = '(1 = 0)';

/** Escape a string value for safe inclusion in a SQL literal. Single quotes
 *  are always doubled (standard SQL escaping). Backslash doubling is
 *  MySQL-only: PostgreSQL (standard_conforming_strings, the default since
 *  9.1) and SQLite treat `\` literally, so doubling there would corrupt the
 *  stored value. */
export function escapeSqlValue(
  value: string | null | undefined,
  dsType?: string,
): string {
  if (value === null || value === undefined) return '';
  let escaped = String(value).replace(/'/g, "''");
  if (dsType !== undefined && dsType.toLowerCase() === 'mysql') {
    escaped = escaped.replace(/\\/g, '\\\\');
  }
  return escaped;
}

/** Escape a LIKE pattern body: the ESCAPE char (backslash), single quotes,
 *  and the wildcards `%`/`_` must all match literally. Backslash is doubled
 *  FIRST so the escapes this function adds are not themselves doubled. */
export function escapeLikeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** Map a filter term to its SQL operator (including the SPACE-separated
 *  `not in` / `not like` literals and the empty-string fallback for unknown
 *  terms). */
export function transFilterTerm(term: string): string {
  switch (term) {
    case 'eq':
      return ' = ';
    case 'not_eq':
      return ' <> ';
    case 'lt':
      return ' < ';
    case 'le':
      return ' <= ';
    case 'gt':
      return ' > ';
    case 'ge':
      return ' >= ';
    case 'in':
      return ' IN ';
    case 'not in':
      return ' NOT IN ';
    case 'like':
      return ' LIKE ';
    case 'not like':
      return ' NOT LIKE ';
    case 'null':
      return ' IS NULL ';
    case 'not_null':
      return ' IS NOT NULL ';
    case 'empty':
      return ' = ';
    case 'not_empty':
      return ' <> ';
    case 'between':
      return ' BETWEEN ';
    default:
      return '';
  }
}

/** Wrap an identifier (field/table/alias) in the engine-appropriate quote
 *  chars, DOUBLING any embedded quote chars so a fieldName containing `"` or
 *  a backtick cannot break out of the identifier. MySQL → backtick;
 *  PostgreSQL/SQLite → double-quote; unknown → double-quote (safe default). */
export function quoteIdentifier(name: string, dsType: string): string {
  const q = dsType.toLowerCase() === 'mysql' ? '`' : '"';
  const doubled = name.split(q).join(q + q);
  return `${q}${doubled}${q}`;
}

// --- the evaluator --------------------------------------------------------

/** AND-join the WHERE fragments of a list of expression trees (one per
 *  matching DsPermission row for a table).
 *  Returns null when every tree yields null (so the caller drops the filter). */
export function transFilterTree(
  trees: FilterTree[],
  ctx: FilterEvalContext,
): string | null {
  if (!trees || trees.length === 0) return null;
  const res: string[] = [];
  for (const tree of trees) {
    if (!tree) continue;
    const exp = transTreeToWhere(tree, ctx);
    if (exp !== null) res.push(exp);
  }
  return res.length > 0 ? res.join(' AND ') : null;
}

const VALID_LOGIC_OPS = new Set(['AND', 'OR']);

/** Render one tree as `(child AND child OR ...)`. Returns null when no child
 *  produced a fragment (empty items list or all children skipped). Invalid
 *  logic op → null (injection guard). Leaf items ALWAYS contribute a
 *  fragment (possibly DENY_FRAGMENT) — only a subtree that is entirely
 *  empty can yield null. */
export function transTreeToWhere(
  tree: FilterTree,
  ctx: FilterEvalContext,
): string | null {
  if (!tree) return null;
  const logic = tree.logic;
  if (!logic || !VALID_LOGIC_OPS.has(String(logic).toUpperCase())) return null;
  const items = tree.items ?? [];
  const parts: string[] = [];
  for (const child of items) {
    if (child.type === 'item') {
      parts.push(transTreeItem(child, ctx));
    } else if (child.type === 'tree' && child.sub_tree) {
      const exp = transTreeToWhere(child.sub_tree, ctx);
      if (exp !== null) parts.push(exp);
    }
  }
  return parts.length > 0 ? `(${parts.join(` ${logic} `)})` : null;
}

/** Render a leaf condition: `<quoted-field> <op> <value>`. A configured
 *  item that cannot render safely (unknown field id, unresolvable variable,
 *  empty enum, malformed between) returns the DENY_FRAGMENT — it never
 *  returns null, so a restriction cannot silently vanish from the WHERE
 *  clause (skipping such items would fail OPEN = widen privileges).
 *  Field-not-found therefore denies too: a rule referencing a since-dropped
 *  column must block, not expose, the rows. No sqlServer nchar/NVARCHAR
 *  unicode-prefix path (unsupported engines). */
export function transTreeItem(
  item: FilterTreeItem,
  ctx: FilterEvalContext,
): string {
  const field = ctx.fieldLookup(item.field_id);
  if (!field) return DENY_FRAGMENT;

  const whereName = quoteIdentifier(field.fieldName, ctx.ds.type);
  const whereTerm = transFilterTerm(item.term);

  if (item.filter_type === 'enum') {
    // Honour `term` — `not in` must NOT be inverted to IN (that would turn
    // an exclusion into an inclusion).
    const enumValues = item.enum_value ?? [];
    if (enumValues.length === 0) return DENY_FRAGMENT;
    const op = item.term === 'not in' ? ' NOT IN ' : ' IN ';
    const escaped = enumValues.map((v) => escapeSqlValue(v, ctx.ds.type));
    return `(${whereName}${op}('${escaped.join("','")}'))`;
  }

  // System/custom variable: resolve the current user's value(s) up front.
  let variableValues: string[] | null = null;
  if (item.value_type === 'variable') {
    if (!ctx.resolveVariable || item.variable_id == null) {
      return DENY_FRAGMENT;
    }
    variableValues = ctx.resolveVariable(item.variable_id);
    if (!variableValues || variableValues.length === 0) {
      return DENY_FRAGMENT;
    }
  }

  const value = item.value ?? '';
  let whereValue = '';

  if (item.term === 'null' || item.term === 'not_null') {
    whereValue = '';
  } else if (item.term === 'empty' || item.term === 'not_empty') {
    whereValue = "''";
  } else if (item.term === 'in' || item.term === 'not in') {
    const parts = (variableValues ?? value.split(',')).map((v) =>
      escapeSqlValue(v, ctx.ds.type),
    );
    whereValue = `('${parts.join("','")}')`;
  } else if (item.term === 'like' || item.term === 'not like') {
    // §116.6d: escape the wildcards + emit an explicit ESCAPE clause so a
    // value's own %/_ match literally. MySQL's string-literal parser eats a
    // bare backslash, so its escape char is written doubled.
    const likeValue = variableValues ? variableValues[0] : value;
    const escapeLiteral =
      ctx.ds.type.toLowerCase() === 'mysql' ? `'\\\\'` : `'\\'`;
    whereValue = `'%${escapeLikeValue(likeValue)}%' ESCAPE ${escapeLiteral}`;
  } else if (item.term === 'between') {
    // §116.4: exactly two non-empty operands are required.
    const rawParts = variableValues ?? value.split(',');
    if (
      rawParts.length !== 2 ||
      rawParts.some((p) => String(p).trim() === '')
    ) {
      return DENY_FRAGMENT;
    }
    whereValue = `'${escapeSqlValue(String(rawParts[0]).trim(), ctx.ds.type)}' AND '${escapeSqlValue(String(rawParts[1]).trim(), ctx.ds.type)}'`;
  } else {
    // eq/not_eq/lt/le/gt/ge → single quoted value (first variable value).
    const scalar = variableValues ? variableValues[0] : value;
    whereValue = `'${escapeSqlValue(scalar, ctx.ds.type)}'`;
  }

  return `${whereName}${whereTerm}${whereValue}`;
}
