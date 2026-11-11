// metric-policy — pure policy for the MetaDataImprove M4 metric system +
// data standards: kind discriminators, strict definition parsing/validation,
// effective resolution by (kind, code) (reusing semantic-policy's layer
// priority), question matching, and prompt rendering for derived/composite
// metrics and naming rules. No Nest/Prisma imports so the rules stay
// unit-testable in isolation — services own all persistence.
//
// Matching is literal-first with an optional vector supplement (M4 follow-up):
// `matchMetricDefinitions` renders every name/alias substring hit, THEN fills
// the remaining `max` slots with ATOMIC metrics whose `kind:code` the caller
// selected via metric vector recall (`opts.fuzzy`, most similar first). The
// ranking guarantees are deliberate:
// - a literal hit is never dropped or reordered for a fuzzy one;
// - derived/composite metrics expand ONLY on a literal hit — a fuzzy hit never
//   invents a composed caliber (a wrong composition is worse than none);
// - modifiers/periods stay literal-only: they inject WHERE constraints, and a
//   fuzzy wrong modifier silently changes the result set;
// - a fuzzy atomic is otherwise rendered exactly like a literal one (same
//   datasource binding, same literal-matched modifiers/period, same tables).
// Services decide whether to consult the vector index at all; with no `fuzzy`
// option the behavior is byte-for-byte the pre-vector matcher.
//
// Known limitations (by design):
// - fuzzy recall only supplements atomics; it cannot surface a derived or
//   composite metric whose name the user never said
// - composite operands may only be atomic/derived/composite codes — modifier
//   or period codes inside an expression are rejected as invalid references
import { pickEffectiveRow } from './semantic-policy';

// ---- kind discriminators ----------------------------------------------

export const METRIC_KINDS = [
  'atomic',
  'modifier',
  'period',
  'derived',
  'composite',
] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const STANDARD_KINDS = ['unit', 'naming'] as const;
export type StandardKind = (typeof STANDARD_KINDS)[number];

export const METRIC_AGGREGATIONS = [
  'SUM',
  'COUNT',
  'COUNT_DISTINCT',
  'AVG',
  'MAX',
  'MIN',
] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export const MODIFIER_OPERATORS = [
  '=',
  '!=',
  'in',
  'not_in',
  'like',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
] as const;
export type ModifierOperator = (typeof MODIFIER_OPERATORS)[number];

export const PERIOD_TIME_UNITS = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type PeriodTimeUnit = (typeof PERIOD_TIME_UNITS)[number];

export const PERIOD_ANCHORS = [
  'yesterday',
  'today',
  'wtd',
  'mtd',
  'qtd',
  'ytd',
] as const;
export type PeriodAnchor = (typeof PERIOD_ANCHORS)[number];

export const UNIT_CATEGORIES = ['currency', 'count', 'time', 'other'] as const;
export const NAMING_CATEGORIES = [
  'business_noun',
  'table_root',
  'field_root',
] as const;

// ---- definition shapes (strict parse targets of the Json column) --------

export interface AtomicDef {
  datasourceId: number;
  tableName: string;
  fieldName: string;
  aggregation: MetricAggregation;
}

export interface ModifierDef {
  datasourceId: number;
  tableName: string;
  fieldName: string;
  operator: ModifierOperator;
  values: string[];
}

export type PeriodDef =
  | { mode: 'recent'; timeUnit: PeriodTimeUnit; count: number }
  | { mode: 'anchor'; anchor: PeriodAnchor };

export interface DerivedDef {
  atomicCode: string;
  modifierCodes?: string[];
  periodCode?: string;
  timeField?: string;
}

export interface CompositeDef {
  expression: string;
}

export type MetricDefinition =
  AtomicDef | ModifierDef | PeriodDef | DerivedDef | CompositeDef;

const isStr = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Strict parse of the stored Json into the typed union. The WIRE and the
 *  stored blob use snake keys (repo convention); the parsed def is camel
 *  internally. Returns null for a malformed payload (save-side rejects
 *  earlier via the DTO + validateInfo, so at runtime a null only means
 *  hand-corrupted data → the row is skipped and the request keeps working). */
export function parseMetricDefinition(
  kind: MetricKind,
  raw: unknown,
): MetricDefinition | null {
  if (raw == null || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  switch (kind) {
    case 'atomic':
      return isPosInt(d.datasource_id) &&
        isStr(d.table_name) &&
        isStr(d.field_name) &&
        oneOf(METRIC_AGGREGATIONS, d.aggregation)
        ? {
            datasourceId: d.datasource_id,
            tableName: d.table_name.trim(),
            fieldName: d.field_name.trim(),
            aggregation: d.aggregation,
          }
        : null;
    case 'modifier':
      return isPosInt(d.datasource_id) &&
        isStr(d.table_name) &&
        isStr(d.field_name) &&
        oneOf(MODIFIER_OPERATORS, d.operator) &&
        Array.isArray(d.values) &&
        d.values.every((v) => isStr(v))
        ? {
            datasourceId: d.datasource_id,
            tableName: d.table_name.trim(),
            fieldName: d.field_name.trim(),
            operator: d.operator,
            values: d.values.map((v) => v.trim()),
          }
        : null;
    case 'period':
      if (d.mode === 'recent') {
        return oneOf(PERIOD_TIME_UNITS, d.time_unit) && isPosInt(d.count)
          ? { mode: 'recent', timeUnit: d.time_unit, count: d.count }
          : null;
      }
      if (d.mode === 'anchor') {
        return oneOf(PERIOD_ANCHORS, d.anchor)
          ? { mode: 'anchor', anchor: d.anchor }
          : null;
      }
      return null;
    case 'derived':
      return isStr(d.atomic_code)
        ? {
            atomicCode: d.atomic_code.trim(),
            modifierCodes: Array.isArray(d.modifier_codes)
              ? d.modifier_codes.filter(isStr).map((c) => c.trim())
              : undefined,
            periodCode: isStr(d.period_code) ? d.period_code.trim() : undefined,
            timeField: isStr(d.time_field) ? d.time_field.trim() : undefined,
          }
        : null;
    case 'composite':
      return isStr(d.expression) ? { expression: d.expression.trim() } : null;
  }
}

/** Cross-field consistency beyond the DTO's per-field shape checks. Returns
 *  an i18n problem key ('metric.*') or null when consistent. */
export function definitionProblem(
  kind: MetricKind,
  def: MetricDefinition,
): string | null {
  switch (kind) {
    case 'atomic':
    case 'modifier': {
      const values = (def as ModifierDef).values;
      if (kind === 'modifier') {
        const op = (def as ModifierDef).operator;
        const n = values?.length ?? 0;
        if (n === 0) return 'metric.def_values_required';
        if (op === 'between' && n !== 2) return 'metric.def_between_two';
        if (['=', 'like', 'gt', 'gte', 'lt', 'lte'].includes(op) && n !== 1) {
          return 'metric.def_value_single';
        }
      }
      return null;
    }
    case 'period': {
      return null; // shape checks live in parseMetricDefinition/DTO
    }
    case 'derived': {
      const dd = def as DerivedDef;
      if (dd.atomicCode === dd.periodCode) return 'metric.def_self_period';
      if (
        dd.modifierCodes &&
        new Set(dd.modifierCodes).size !== dd.modifierCodes.length
      ) {
        return 'metric.def_dup_modifiers';
      }
      return null;
    }
    case 'composite':
      return null; // expression syntax is expressionProblem()'s job
  }
}

// ---- composite expressions ----------------------------------------------

/** A metric code token: letter first, then letters/digits/underscore. */
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Bounds on stored composite expressions (see expressionProblem). */
const MAX_EXPRESSION_LENGTH = 4_000;
const MAX_EXPRESSION_TOKENS = 200;
/** Composite nesting bound — a chain of N composites renders recursively. */
const MAX_COMPOSITE_DEPTH = 8;
/** Per-operand display-name bound inside a rendered expression. */
const MAX_RENDER_LABEL = 120;

const clipLabel = (value: string): string =>
  value.length > MAX_RENDER_LABEL
    ? `${value.slice(0, MAX_RENDER_LABEL - 1)}…`
    : value;

/** Strict expression syntax check. Tokens may only be metric codes, decimal
 *  numbers, + - * / ( ) and whitespace; parens must balance; at least one
 *  code reference; self-reference rejected. Returns an i18n problem key. */
export function expressionProblem(
  expression: string,
  ownCode: string,
): string | null {
  const expr = expression.trim();
  if (!expr) return 'metric.expression_invalid';
  // Hard caps: a stored PERSONAL metric is written by any member and rendered
  // synchronously on every matching chat. Without a bound, one giant
  // expression turns the token walk (and the O(n) display-name replacement
  // below) into a multi-second event-loop block.
  if (expr.length > MAX_EXPRESSION_LENGTH) return 'metric.expression_invalid';
  let depth = 0;
  let refs = 0;
  const toks =
    expr.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/()]|\S/g) ?? [];
  if (toks.length > MAX_EXPRESSION_TOKENS) return 'metric.expression_invalid';
  for (const tok of toks) {
    if (/^[+\-*/]$/.test(tok) || tok === '(') {
      if (tok === '(') depth += 1;
      continue;
    }
    if (tok === ')') {
      depth -= 1;
      if (depth < 0) return 'metric.expression_invalid';
      continue;
    }
    if (/^\d/.test(tok)) continue; // number literal
    if (CODE_TOKEN.test(tok)) {
      if (tok === ownCode) return 'metric.expression_self_ref';
      refs += 1;
      continue;
    }
    return 'metric.expression_invalid';
  }
  if (depth !== 0) return 'metric.expression_invalid';
  if (refs === 0) return 'metric.expression_no_refs';
  return null;
}

/** The metric codes an expression references (deduped, order of appearance). */
export function expressionCodes(expression: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

// ---- rows (Prisma-free structural shape) --------------------------------

export interface MetricDefLike {
  id: number;
  kind: string;
  code: string;
  name: string;
  aliases: unknown;
  description: string | null;
  unit: string | null;
  definition: unknown;
  scope: string;
  oid: number | null;
  ownerUid: number | null;
  enabled: boolean;
  updatedAt: Date | string;
}

export interface DataStandardLike {
  id: number;
  kind: string;
  code: string;
  term: string;
  name: string;
  aliases: unknown;
  category: string | null;
  description: string | null;
  scope: string;
  oid: number | null;
  ownerUid: number | null;
  enabled: boolean;
  updatedAt: Date | string;
}

const keyOf = (kind: string, code: string): string => `${kind}:${code}`;

/** Effective resolution per (kind, code): group the caller-loaded visible
 *  rows, pick PERSONAL > WORKSPACE > GLOBAL via semantic-policy. Works for
 *  both dictionaries (any row carrying kind/code/scope). */
export function effectiveByCode<
  T extends { kind: string; code: string; scope: string; updatedAt?: unknown },
>(rows: T[]): Map<string, T> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r.kind, r.code);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const out = new Map<string, T>();
  for (const [k, list] of groups) {
    const effective = pickEffectiveRow(
      list as Array<T & { updatedAt?: unknown }>,
    );
    if (effective) out.set(k, effective);
  }
  return out;
}

// ---- question matching ---------------------------------------------------

/** The match candidates of one row: trimmed name + string aliases, dropping
 *  empties and sub-2-char noise (a 1-char CJK inclusion match is almost
 *  always a false positive). */
export function matchNames(name: string, aliases: unknown): string[] {
  const out = [name];
  if (Array.isArray(aliases)) {
    for (const a of aliases) if (typeof a === 'string') out.push(a);
  }
  return [...new Set(out.map((s) => s.trim()).filter((s) => s.length >= 2))];
}

/** Case-insensitive substring inclusion against the question. */
export function matchesQuestion(
  name: string,
  aliases: unknown,
  question: string,
): boolean {
  const q = question.toLowerCase();
  return matchNames(name, aliases).some((n) => q.includes(n.toLowerCase()));
}

// ---- rendering (prompt text) ---------------------------------------------

const TIME_UNIT_ZH: Record<PeriodTimeUnit, string> = {
  day: '天',
  week: '周',
  month: '月',
  quarter: '季度',
  year: '年',
};

const ANCHOR_ZH: Record<PeriodAnchor, string> = {
  yesterday: '昨日',
  today: '今日',
  wtd: '本周至今',
  mtd: '本月至今',
  qtd: '本季度至今',
  ytd: '本年度至今',
};

function aggText(def: AtomicDef): string {
  const target = `${def.tableName}.${def.fieldName}`;
  return def.aggregation === 'COUNT_DISTINCT'
    ? `COUNT(DISTINCT ${target})`
    : `${def.aggregation}(${target})`;
}

/** `field op values` — the SQL-shaped hint the LLM turns into a WHERE. */
export function conditionText(def: ModifierDef): string {
  const target = `${def.tableName}.${def.fieldName}`;
  const one = () => def.values[0] ?? '';
  switch (def.operator) {
    case '=':
      return `${target} = ${one()}`;
    case '!=':
      return `${target} != ${one()}`;
    case 'in':
      return `${target} IN (${def.values.join(', ')})`;
    case 'not_in':
      return `${target} NOT IN (${def.values.join(', ')})`;
    case 'like':
      return `${target} LIKE '%${one()}%'`;
    case 'gt':
      return `${target} > ${one()}`;
    case 'gte':
      return `${target} >= ${one()}`;
    case 'lt':
      return `${target} < ${one()}`;
    case 'lte':
      return `${target} <= ${one()}`;
    case 'between':
      return `${target} BETWEEN ${def.values.join(' AND ')}`;
  }
}

export function periodText(def: PeriodDef): string {
  return def.mode === 'recent'
    ? `最近${def.count}${TIME_UNIT_ZH[def.timeUnit]}`
    : ANCHOR_ZH[def.anchor];
}

/** Rendering context: the effective rows to resolve references through and
 *  the per-table default time field (from FieldSemantic role=time). */
export interface MetricRenderContext {
  rows: Map<string, MetricDefLike>;
  /** The datasource the current question runs against. Derived/composite
   *  definitions carry no datasourceId of their own, so their resolved atomics
   *  (and modifiers) MUST bind to this id — otherwise a metric authored for
   *  datasource A injects A's table/caliber into a B question. */
  datasourceId: number;
  timeFieldOf: (tableName: string) => string | undefined;
}

export interface RenderedMetric {
  /** Compact one-line caliber, also used inside composite expressions. */
  line: string;
  /** Full block (nested sub-lines for composites), without the bullet. */
  block: string;
  /** Every atomic table touched — the schema-stuffing hint. */
  tables: string[];
}

/** Cap on composite expansion: operand sub-lines per composite metric. */
const COMPOSITE_SUBLINE_CAP = 8;

function atomicLine(row: MetricDefLike, def: AtomicDef): string {
  const unit = row.unit?.trim() ? `; 单位: ${row.unit.trim()}` : '';
  return `口径 = ${aggText(def)}${unit}`;
}

/** Resolve + render a derived metric. Null = dangling reference (its atomic
 *  or a modifier/period code resolves to nothing) — the caller skips. */
export function renderDerived(
  row: MetricDefLike,
  ctx: MetricRenderContext,
): RenderedMetric | null {
  const def = parseMetricDefinition(
    'derived',
    row.definition,
  ) as DerivedDef | null;
  if (!def) return null;
  const atomicRow = ctx.rows.get(keyOf('atomic', def.atomicCode));
  const atomic = atomicRow
    ? (parseMetricDefinition(
        'atomic',
        atomicRow.definition,
      ) as AtomicDef | null)
    : null;
  if (!atomicRow || !atomic) return null;
  // Derived definitions bind through their atomic; a derived metric authored
  // for another datasource must not render on this question.
  if (atomic.datasourceId !== ctx.datasourceId) return null;

  const modifierRows: Array<{ row: MetricDefLike; def: ModifierDef }> = [];
  for (const code of def.modifierCodes ?? []) {
    const m = ctx.rows.get(keyOf('modifier', code));
    const md = m
      ? (parseMetricDefinition('modifier', m.definition) as ModifierDef | null)
      : null;
    // A modifier is a WHERE constraint — it must bind to the same datasource
    // (and table) as the atomic it composes with.
    if (!m || !md || md.datasourceId !== atomic.datasourceId) return null;
    modifierRows.push({ row: m, def: md });
  }
  let period: PeriodDef | null = null;
  if (def.periodCode) {
    const p = ctx.rows.get(keyOf('period', def.periodCode));
    period = p
      ? (parseMetricDefinition('period', p.definition) as PeriodDef | null)
      : null;
    if (!period) return null;
  }

  const timeField =
    def.timeField?.trim() || ctx.timeFieldOf(atomic.tableName) || '';
  const parts = [atomicLine(atomicRow, atomic)];
  if (modifierRows.length > 0) {
    parts.push(
      `修饰: ${modifierRows.map(({ def: md }) => conditionText(md)).join('; ')}`,
    );
  }
  if (period) {
    const by = timeField ? ` 按 ${atomic.tableName}.${timeField}` : '';
    parts.push(`时间: ${periodText(period)}${by}`);
  }
  const line = `${row.name} (${row.code}): ${parts.join('; ')}`;
  return { line, block: line, tables: [atomic.tableName] };
}

/** Render one operand of a composite (atomic/derived/composite rows only).
 *  Null = unresolvable or cyclic — the caller skips the whole composite. */
function renderOperand(
  row: MetricDefLike,
  ctx: MetricRenderContext,
  seen: Set<string>,
  depth: number,
): RenderedMetric | null {
  if (depth > MAX_COMPOSITE_DEPTH) return null;
  if (seen.has(keyOf(row.kind, row.code))) return null; // cycle guard
  if (row.kind === 'atomic') {
    const def = parseMetricDefinition(
      'atomic',
      row.definition,
    ) as AtomicDef | null;
    if (!def || def.datasourceId !== ctx.datasourceId) return null;
    const line = `${row.name} (${row.code}): ${atomicLine(row, def)}`;
    return { line, block: line, tables: [def.tableName] };
  }
  if (row.kind === 'derived') return renderDerived(row, ctx);
  if (row.kind === 'composite') return renderComposite(row, ctx, seen, depth);
  return null; // modifier/period codes are not valid operands
}

/** Resolve + render a composite: the expression with codes swapped for
 *  operand display names, plus capped nested sub-lines. */
export function renderComposite(
  row: MetricDefLike,
  ctx: MetricRenderContext,
  seen = new Set<string>(),
  depth = 0,
): RenderedMetric | null {
  if (depth > MAX_COMPOSITE_DEPTH) return null;
  const def = parseMetricDefinition(
    'composite',
    row.definition,
  ) as CompositeDef | null;
  if (!def) return null;
  const codes = expressionCodes(def.expression);
  if (codes.length === 0) return null;
  const key = keyOf(row.kind, row.code);
  if (seen.has(key)) return null; // cycle guard
  // Path-scoped visited set: add before descending and remove afterwards, so
  // a DAG that reuses the same operand (A = B + C, C = B + 1) still renders —
  // only a genuine cycle hits this check.
  seen.add(key);
  try {
    const rendered: RenderedMetric[] = [];
    const tables: string[] = [];
    for (const code of codes) {
      const target =
        ctx.rows.get(keyOf('derived', code)) ??
        ctx.rows.get(keyOf('composite', code)) ??
        ctx.rows.get(keyOf('atomic', code));
      const r = target ? renderOperand(target, ctx, seen, depth + 1) : null;
      if (!r) return null;
      rendered.push(r);
      for (const t of r.tables) if (!tables.includes(t)) tables.push(t);
    }
    // Operand names inside the expression: swap each code for its display name
    // so the LLM reads 客单价 = 支付金额 / 支付用户数, not raw codes.
    let expr = def.expression;
    codes.forEach((code) => {
      const target =
        ctx.rows.get(keyOf('derived', code)) ??
        ctx.rows.get(keyOf('composite', code)) ??
        ctx.rows.get(keyOf('atomic', code));
      const display = target ? clipLabel(target.name) : code;
      expr = expr.replace(new RegExp(`\\b${code}\\b`, 'g'), display);
    });
    const line = `${row.name} (${row.code}) = ${expr}`;
    const subLines = rendered
      .slice(0, COMPOSITE_SUBLINE_CAP)
      .map((r) => `    - ${r.line}`);
    return { line, block: [line, ...subLines].join('\n'), tables };
  } finally {
    seen.delete(key);
  }
}

// ---- the whole-question matcher -------------------------------------------

/** Why the service could not consult the vector index. Set by the service on
 *  the result (never by the pure matcher) so callers can log/diagnose a
 *  literal-only run without parsing logs. */
export type MetricRecallDegradeReason =
  'disabled' | 'no_config' | 'no_embedding' | 'no_vector' | 'error';

export interface MetricMatchResult {
  /** `<metric_definitions>` block ('' when nothing matched). */
  text: string;
  /** Atomic tables of every rendered metric — force-stuff into the schema. */
  atomicTableNames: string[];
  /** How many metrics rendered (for the metric.max_definitions cap report). */
  matched: number;
  /** Present when vector recall was skipped — the run is literal-only. */
  degradeReason?: MetricRecallDegradeReason;
}

export interface MetricMatchOptions {
  /** Vector-recall candidates as `kind:code` keys, most similar first. Only
   *  ATOMIC entries are expanded (see the header rules); the caller has
   *  already applied the similarity threshold and the row invisibility
   *  filter, and builds the keys from the EFFECTIVE row so layer priority
   *  still wins. Omitted → pure literal matching. */
  fuzzy?: readonly string[];
}

/** Match a question against the actor-visible enabled metric rows of ONE
 *  datasource and render the definitions the LLM should honor:
 *  1. derived/composite metrics whose name/alias appears in the question
 *  2. atomic metrics likewise — composed ad hoc with any modifier of the
 *     same table and the first matching period that also appears in the
 *     question
 *  3. then, only while `max` has room, atomic metrics from `opts.fuzzy`
 *  Rows of other datasources never render (atomic/modifier defs are filtered
 *  by datasourceId; derived/composite only render through their atomics).
 *  Dangling references and cycles skip the metric, never the request. */
export function matchMetricDefinitions(
  rows: MetricDefLike[],
  datasourceId: number,
  question: string,
  max: number,
  timeFieldOf: (tableName: string) => string | undefined,
  opts?: MetricMatchOptions,
): MetricMatchResult {
  const effective = effectiveByCode(rows);
  const ctx: MetricRenderContext = {
    rows: effective,
    datasourceId,
    timeFieldOf,
  };

  const isDsBound = (row: MetricDefLike): boolean => {
    if (row.kind === 'atomic' || row.kind === 'modifier') {
      const def = parseMetricDefinition(row.kind, row.definition) as
        AtomicDef | ModifierDef | null;
      return def?.datasourceId === datasourceId;
    }
    return true; // period/derived/composite bind through their references
  };
  const inScope = [...effective.values()].filter(
    (r) => r.enabled && isDsBound(r),
  );

  const blocks: string[] = [];
  const tables: string[] = [];
  const coveredAtomicCodes = new Set<string>();

  const push = (r: RenderedMetric | null): boolean => {
    if (!r) return false;
    blocks.push(`- ${r.block}`);
    for (const t of r.tables) if (!tables.includes(t)) tables.push(t);
    return true;
  };

  // 1) matched derived + composite metrics (question names them outright)
  for (const row of inScope) {
    if (row.kind !== 'derived' && row.kind !== 'composite') continue;
    if (blocks.length >= max) break;
    if (!matchesQuestion(row.name, row.aliases, question)) continue;
    const rendered =
      row.kind === 'derived'
        ? renderDerived(row, ctx)
        : renderComposite(row, ctx);
    if (push(rendered)) {
      // remember which atomics this metric already covers (skip their ad-hoc
      // rendering below so the same caliber is not stated twice)
      const def = parseMetricDefinition(
        'derived',
        row.definition,
      ) as DerivedDef | null;
      if (def?.atomicCode) coveredAtomicCodes.add(def.atomicCode);
    }
  }

  // 2) matched modifiers/periods for ad-hoc composition with matched atomics.
  //    Literal-only on purpose: a modifier is a WHERE constraint, so a fuzzy
  //    wrong one silently changes the numbers.
  const matchedModifiers = inScope.filter(
    (r) =>
      r.kind === 'modifier' && matchesQuestion(r.name, r.aliases, question),
  );
  const matchedPeriod = inScope.find(
    (r) => r.kind === 'period' && matchesQuestion(r.name, r.aliases, question),
  );

  /** Render one atomic (with any literal-matched modifier/period of the same
   *  table). Shared by the literal and fuzzy passes so both produce exactly
   *  the same caliber text. */
  const renderAtomic = (row: MetricDefLike): string | null => {
    const def = parseMetricDefinition(
      'atomic',
      row.definition,
    ) as AtomicDef | null;
    if (!def) return null;
    const parts = [atomicLine(row, def)];
    const mods = matchedModifiers
      .map((m) => ({
        row: m,
        def: parseMetricDefinition(
          'modifier',
          m.definition,
        ) as ModifierDef | null,
      }))
      .filter(
        (m): m is { row: MetricDefLike; def: ModifierDef } =>
          !!m.def &&
          m.def.datasourceId === def.datasourceId &&
          m.def.tableName === def.tableName,
      );
    if (mods.length > 0) {
      parts.push(`修饰: ${mods.map((m) => conditionText(m.def)).join('; ')}`);
    }
    if (matchedPeriod) {
      const p = parseMetricDefinition(
        'period',
        matchedPeriod.definition,
      ) as PeriodDef | null;
      if (p) {
        const timeField = timeFieldOf(def.tableName);
        const by = timeField ? ` 按 ${def.tableName}.${timeField}` : '';
        parts.push(`时间: ${periodText(p)}${by}`);
      }
    }
    const line = `${row.name} (${row.code}): ${parts.join('; ')}`;
    if (!tables.includes(def.tableName)) tables.push(def.tableName);
    return line;
  };

  const renderedAtomicCodes = new Set<string>();
  for (const row of inScope) {
    if (blocks.length >= max) break;
    if (row.kind !== 'atomic') continue;
    if (coveredAtomicCodes.has(row.code)) continue;
    if (!matchesQuestion(row.name, row.aliases, question)) continue;
    const line = renderAtomic(row);
    if (!line) continue;
    blocks.push(`- ${line}`);
    renderedAtomicCodes.add(row.code);
  }

  // 3) vector supplement: ATOMIC only, most-similar first, never evicting a
  //    literal hit and never re-stating one (covered / already rendered).
  for (const key of opts?.fuzzy ?? []) {
    if (blocks.length >= max) break;
    const row = effective.get(key);
    if (!row || row.kind !== 'atomic') continue;
    if (!row.enabled || !isDsBound(row)) continue;
    if (coveredAtomicCodes.has(row.code)) continue;
    if (renderedAtomicCodes.has(row.code)) continue;
    // a literal hit would already be in `renderedAtomicCodes`; the guard
    // keeps a caller-supplied key from bypassing the literal naming rule
    if (matchesQuestion(row.name, row.aliases, question)) continue;
    const line = renderAtomic(row);
    if (!line) continue;
    blocks.push(`- ${line}`);
    renderedAtomicCodes.add(row.code);
  }

  if (blocks.length === 0)
    return { text: '', atomicTableNames: [], matched: 0 };
  return {
    text: `<metric_definitions>\n${blocks.join('\n')}\n</metric_definitions>`,
    atomicTableNames: tables,
    matched: blocks.length,
  };
}

// ---- naming rules (data standards) ----------------------------------------

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Match naming-dictionary entries against the question and render the
 *  `<naming_rules>` block ('' when nothing matched). Standard translation +
 *  description teach the LLM the enterprise vocabulary. */
export function namingTemplate(
  rows: DataStandardLike[],
  question: string,
  max: number,
): string {
  const effective = effectiveByCode(
    rows.filter((r) => r.kind === 'naming' && r.enabled),
  );
  const matched = [...effective.values()].filter((r) =>
    matchesQuestion(r.term, r.aliases, question),
  );
  if (matched.length === 0) return '';
  const lines = matched.slice(0, max).map((r) => {
    const attrs = [
      `term="${xmlEscape(r.term)}"`,
      `standard="${xmlEscape(r.name)}"`,
    ];
    if (r.category) attrs.push(`category="${xmlEscape(r.category)}"`);
    if (r.description?.trim()) {
      attrs.push(`description="${xmlEscape(r.description.trim())}"`);
    }
    return `  <rule ${attrs.join(' ')} />`;
  });
  return `<naming_rules>\n${lines.join('\n')}\n</naming_rules>`;
}
