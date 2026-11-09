// Pure-policy unit tests for the M4 metric system: definition parsing,
// composite expression validation, effective resolution priority, question
// matching and prompt rendering — no Nest/Prisma involved.
import {
  METRIC_KINDS,
  conditionText,
  definitionProblem,
  effectiveByCode,
  expressionCodes,
  expressionProblem,
  matchMetricDefinitions,
  matchNames,
  matchesQuestion,
  namingTemplate,
  parseMetricDefinition,
  periodText,
  type MetricDefLike,
  type DataStandardLike,
} from './metric-policy';

const base = (over: Partial<MetricDefLike>): MetricDefLike => ({
  id: 1,
  kind: 'atomic',
  code: 'x',
  name: 'x',
  aliases: null,
  description: null,
  unit: null,
  definition: {},
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  enabled: true,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('parseMetricDefinition', () => {
  it('parses each kind and rejects malformed payloads', () => {
    expect(
      parseMetricDefinition('atomic', {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'pay_amount',
        aggregation: 'SUM',
      }),
    ).toEqual({
      datasourceId: 1,
      tableName: 'orders',
      fieldName: 'pay_amount',
      aggregation: 'SUM',
    });
    expect(
      parseMetricDefinition('atomic', { datasource_id: 1, aggregation: 'SUM' }),
    ).toBeNull();
    expect(
      parseMetricDefinition('modifier', {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'channel',
        operator: 'in',
        values: ['app', 'h5'],
      }),
    ).toEqual({
      datasourceId: 1,
      tableName: 'orders',
      fieldName: 'channel',
      operator: 'in',
      values: ['app', 'h5'],
    });
    // strict parse: a whitespace-only value never round-trips (save-side
    // rejects it via the DTO; runtime null = skip the row)
    expect(
      parseMetricDefinition('modifier', {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'channel',
        operator: 'in',
        values: ['app', ' '],
      }),
    ).toBeNull();
    expect(
      parseMetricDefinition('period', {
        mode: 'recent',
        time_unit: 'day',
        count: 7,
      }),
    ).toEqual({ mode: 'recent', timeUnit: 'day', count: 7 });
    expect(
      parseMetricDefinition('period', { mode: 'recent', time_unit: 'day' }),
    ).toBeNull();
    expect(
      parseMetricDefinition('period', { mode: 'anchor', anchor: 'mtd' }),
    ).toEqual({ mode: 'anchor', anchor: 'mtd' });
    expect(
      parseMetricDefinition('derived', { atomic_code: ' pay_amount ' }),
    ).toEqual({ atomicCode: 'pay_amount' });
    expect(parseMetricDefinition('derived', {})).toBeNull();
    expect(
      parseMetricDefinition('composite', { expression: ' a / b ' }),
    ).toEqual({
      expression: 'a / b',
    });
  });

  it('covers every registered kind', () => {
    expect([...METRIC_KINDS]).toEqual([
      'atomic',
      'modifier',
      'period',
      'derived',
      'composite',
    ]);
  });
});

describe('definitionProblem', () => {
  it('enforces modifier value arity', () => {
    const mk = (op: string, values: string[]) =>
      definitionProblem('modifier', {
        datasourceId: 1,
        tableName: 't',
        fieldName: 'f',
        operator: op,
        values,
      } as never);
    expect(mk('between', ['a'])).toBe('metric.def_between_two');
    expect(mk('between', ['a', 'b'])).toBeNull();
    expect(mk('=', [])).toBe('metric.def_values_required');
    expect(mk('=', ['a', 'b'])).toBe('metric.def_value_single');
    expect(mk('=', ['a'])).toBeNull();
    expect(mk('in', ['a', 'b', 'c'])).toBeNull();
  });

  it('rejects duplicate modifier references and self period on derived', () => {
    expect(
      definitionProblem('derived', {
        atomicCode: 'a',
        modifierCodes: ['m', 'm'],
      }),
    ).toBe('metric.def_dup_modifiers');
    expect(
      definitionProblem('derived', {
        atomicCode: 'a',
        periodCode: 'a',
      }),
    ).toBe('metric.def_self_period');
  });
});

describe('expressionProblem / expressionCodes', () => {
  it('accepts arithmetic over codes and numbers', () => {
    expect(expressionProblem('(a_1 - b2) / 3.5', 'self')).toBeNull();
    expect(expressionCodes('(a_1 - b2) / a_1')).toEqual(['a_1', 'b2']);
  });

  it('rejects imbalance, foreign tokens, self-reference and no refs', () => {
    expect(expressionProblem('(a + b', 'x')).toBe('metric.expression_invalid');
    expect(expressionProblem('a & b', 'x')).toBe('metric.expression_invalid');
    expect(expressionProblem('a ^ b', 'x')).toBe('metric.expression_invalid');
    expect(expressionProblem('1 + 2', 'x')).toBe('metric.expression_no_refs');
    expect(expressionProblem('self + a', 'self')).toBe(
      'metric.expression_self_ref',
    );
  });
});

describe('effectiveByCode', () => {
  it('picks PERSONAL > WORKSPACE > GLOBAL per (kind, code)', () => {
    const g = base({ id: 1, scope: 'GLOBAL', kind: 'atomic', code: 'pay' });
    const w = base({ id: 2, scope: 'WORKSPACE', kind: 'atomic', code: 'pay' });
    const p = base({ id: 3, scope: 'PERSONAL', kind: 'atomic', code: 'pay' });
    const other = base({
      id: 4,
      scope: 'WORKSPACE',
      kind: 'atomic',
      code: 'q',
    });
    const map = effectiveByCode([g, w, p, other]);
    expect(map.get('atomic:pay')?.id).toBe(3);
    expect(map.get('atomic:q')?.id).toBe(4);
  });
});

describe('matching', () => {
  it('matches names and aliases case-insensitively, drops 1-char noise', () => {
    expect(matchNames('支付金额', ['Pay Amount', ' ', 'x'])).toEqual([
      '支付金额',
      'Pay Amount',
    ]);
    expect(
      matchesQuestion('支付金额', ['pay amount'], '最近7天PAY AMOUNT总和'),
    ).toBe(true);
    // 1-char candidates are noise; a longer name does not fuzzy-match
    expect(matchesQuestion('付', null, '支付方式分布')).toBe(false);
    expect(matchesQuestion('支付金额', null, '支付方式分布')).toBe(false);
  });
});

describe('rendering helpers', () => {
  it('renders conditions and periods', () => {
    expect(
      conditionText({
        datasourceId: 1,
        tableName: 'orders',
        fieldName: 'category',
        operator: 'in',
        values: ['母婴', '玩具'],
      }),
    ).toBe('orders.category IN (母婴, 玩具)');
    expect(
      conditionText({
        datasourceId: 1,
        tableName: 'orders',
        fieldName: 'pay_time',
        operator: 'between',
        values: ['2026-01-01', '2026-06-30'],
      }),
    ).toBe('orders.pay_time BETWEEN 2026-01-01 AND 2026-06-30');
    expect(periodText({ mode: 'recent', timeUnit: 'day', count: 7 })).toBe(
      '最近7天',
    );
    expect(periodText({ mode: 'anchor', anchor: 'mtd' })).toBe('本月至今');
  });
});

describe('matchMetricDefinitions', () => {
  const ds = 1;
  const rows: MetricDefLike[] = [
    base({
      id: 11,
      kind: 'atomic',
      code: 'pay_amount',
      name: '支付金额',
      unit: '元',
      definition: {
        datasource_id: ds,
        table_name: 'orders',
        field_name: 'pay_amount',
        aggregation: 'SUM',
      },
    }),
    base({
      id: 12,
      kind: 'atomic',
      code: 'pay_users',
      name: '支付用户数',
      definition: {
        datasource_id: ds,
        table_name: 'orders',
        field_name: 'user_id',
        aggregation: 'COUNT_DISTINCT',
      },
    }),
    base({
      id: 13,
      kind: 'atomic',
      code: 'other_ds_metric',
      name: '支付金额',
      definition: {
        datasource_id: 99,
        table_name: 'other.orders',
        field_name: 'amount',
        aggregation: 'SUM',
      },
    }),
    base({
      id: 21,
      kind: 'modifier',
      code: 'baby',
      name: '母婴类',
      definition: {
        datasource_id: ds,
        table_name: 'orders',
        field_name: 'category',
        operator: '=',
        values: ['母婴'],
      },
    }),
    base({
      id: 31,
      kind: 'period',
      code: 'last_7d',
      name: '最近7天',
      definition: { mode: 'recent', time_unit: 'day', count: 7 },
    }),
    base({
      id: 41,
      kind: 'derived',
      code: 'baby_pay_7d',
      name: '近7天母婴支付金额',
      definition: {
        atomic_code: 'pay_amount',
        modifier_codes: ['baby'],
        period_code: 'last_7d',
      },
    }),
    base({
      id: 42,
      kind: 'derived',
      code: 'broken',
      name: '坏指标',
      definition: { atomic_code: 'missing_atomic' },
    }),
    base({
      id: 43,
      kind: 'derived',
      code: 'pay_7d',
      name: '近7天支付金额',
      definition: { atomic_code: 'pay_amount', period_code: 'last_7d' },
    }),
    base({
      id: 51,
      kind: 'composite',
      code: 'atv',
      name: '客单价',
      definition: { expression: 'pay_7d / pay_users' },
    }),
    base({
      id: 52,
      kind: 'composite',
      code: 'cycle_a',
      name: '环指标A',
      definition: { expression: 'cycle_b + pay_7d' },
    }),
    base({
      id: 53,
      kind: 'composite',
      code: 'cycle_b',
      name: '环指标B',
      definition: { expression: 'cycle_a' },
    }),
  ];
  const timeFieldOf = (t: string) => (t === 'orders' ? 'pay_time' : undefined);

  it('renders a matched derived metric with modifier + period + time field', () => {
    const r = matchMetricDefinitions(
      rows,
      ds,
      '统计近7天母婴支付金额',
      5,
      timeFieldOf,
    );
    expect(r.matched).toBe(1);
    expect(r.atomicTableNames).toEqual(['orders']);
    expect(r.text).toContain(
      '近7天母婴支付金额 (baby_pay_7d): 口径 = SUM(orders.pay_amount); 单位: 元; 修饰: orders.category = 母婴; 时间: 最近7天 按 orders.pay_time',
    );
  });

  it('renders a composite with named operands and skips cycles + dangling', () => {
    const r = matchMetricDefinitions(
      rows,
      ds,
      '近7天客单价与坏指标和环指标A',
      5,
      timeFieldOf,
    );
    // cycle_a cannot resolve (cycle_b → cycle_a) and broken lacks its atomic;
    // only the composite atv renders.
    expect(r.matched).toBe(1);
    expect(r.text).toContain('客单价 (atv) = 近7天支付金额 / 支付用户数');
    expect(r.text).toContain(
      '- 近7天支付金额 (pay_7d): 口径 = SUM(orders.pay_amount)',
    );
    expect(r.text).toContain(
      '支付用户数 (pay_users): 口径 = COUNT(DISTINCT orders.user_id)',
    );
    expect(r.atomicTableNames).toEqual(['orders']);
  });

  it('composes a matched atomic ad hoc with same-table modifier + matched period', () => {
    const r = matchMetricDefinitions(
      rows,
      ds,
      '母婴类最近7天的支付金额',
      5,
      timeFieldOf,
    );
    expect(r.matched).toBe(1);
    expect(r.text).toContain(
      '支付金额 (pay_amount): 口径 = SUM(orders.pay_amount); 单位: 元',
    );
    expect(r.text).toContain('修饰: orders.category = 母婴');
    expect(r.text).toContain('时间: 最近7天 按 orders.pay_time');
  });

  it('never injects another datasource metric and caps definitions', () => {
    // id 13 shadows the name on datasource 99; only the ds-1 atomic may win.
    const q = '支付金额';
    const one = matchMetricDefinitions(rows, ds, q, 5, timeFieldOf);
    expect(one.text).toContain('SUM(orders.pay_amount)');
    expect(one.text).not.toContain('other.orders');
    const capped = matchMetricDefinitions(
      rows,
      ds,
      '支付金额 支付用户数 近7天母婴支付金额 近7天支付金额 客单价 坏指标',
      2,
      timeFieldOf,
    );
    expect(capped.matched).toBe(2);
  });
});

describe('namingTemplate', () => {
  const std: DataStandardLike[] = [
    {
      id: 1,
      kind: 'naming',
      code: 'annual_revenue',
      term: '年营收',
      name: '年度总营业额',
      aliases: ['annual revenue'],
      category: 'business_noun',
      description: '衡量公司年度收入 <标准>',
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      enabled: true,
      updatedAt: new Date(),
    },
    {
      id: 2,
      kind: 'unit',
      code: 'jian',
      term: '件',
      name: '件',
      aliases: null,
      category: 'count',
      description: null,
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      enabled: true,
      updatedAt: new Date(),
    },
  ];

  it('matches term/alias, escapes XML, ignores units, honors the cap', () => {
    const text = namingTemplate(std, '对比一下ANNUAL REVENUE', 5);
    expect(text).toContain('term="年营收"');
    expect(text).toContain('standard="年度总营业额"');
    expect(text).toContain('description="衡量公司年度收入 &lt;标准&gt;"');
    expect(namingTemplate(std, '买了多少件', 5)).toBe('');
    expect(namingTemplate(std, '', 5)).toBe('');
  });
});
