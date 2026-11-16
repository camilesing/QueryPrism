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
  renderComposite,
  renderDerived,
  type DataStandardLike,
  type MetricDefLike,
  type MetricRenderContext,
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

describe('matchMetricDefinitions vector supplement', () => {
  const atomic = (over: Partial<MetricDefLike>): MetricDefLike =>
    base({
      kind: 'atomic',
      definition: {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'pay_amount',
        aggregation: 'SUM',
      },
      ...over,
    });
  const pay = atomic({ id: 1, code: 'pay_amount', name: '支付金额' });
  const refund = atomic({
    id: 2,
    code: 'refund_amount',
    name: '退款金额',
    definition: {
      datasource_id: 1,
      table_name: 'orders',
      field_name: 'refund_amount',
      aggregation: 'SUM',
    },
  });

  it('renders fuzzy atomics AFTER every literal hit', () => {
    const r = matchMetricDefinitions(
      [refund, pay],
      1,
      '支付金额趋势',
      5,
      () => undefined,
      {
        fuzzy: ['atomic:refund_amount'],
      },
    );
    expect(r.matched).toBe(2);
    expect(r.text.indexOf('支付金额')).toBeLessThan(r.text.indexOf('退款金额'));
  });

  it('never evicts a literal hit when the cap is reached', () => {
    const r = matchMetricDefinitions(
      [refund, pay],
      1,
      '支付金额',
      1,
      () => undefined,
      {
        fuzzy: ['atomic:refund_amount'],
      },
    );
    expect(r.matched).toBe(1);
    expect(r.text).toContain('pay_amount');
    expect(r.text).not.toContain('refund_amount');
  });

  it('ignores fuzzy hits for derived/composite metrics', () => {
    const derived = base({
      id: 3,
      kind: 'derived',
      code: 'baby_pay',
      name: '母婴支付金额',
      definition: { atomic_code: 'pay_amount' },
    });
    const r = matchMetricDefinitions(
      [pay, derived],
      1,
      '趋势',
      5,
      () => undefined,
      {
        fuzzy: ['derived:baby_pay'],
      },
    );
    expect(r.matched).toBe(0);
    expect(r.text).toBe('');
  });

  it('ignores fuzzy hits for modifiers/periods (WHERE constraints stay literal)', () => {
    const modifier = base({
      id: 4,
      kind: 'modifier',
      code: 'baby',
      name: '母婴',
      definition: {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'category',
        operator: 'IN',
        values: ['母婴'],
      },
    });
    const r = matchMetricDefinitions(
      [pay, modifier],
      1,
      '支付金额',
      5,
      () => undefined,
      {
        fuzzy: ['modifier:baby'],
      },
    );
    expect(r.text).toContain('支付金额');
    expect(r.text).not.toContain('母婴');
  });

  it('drops a fuzzy atomic bound to another datasource', () => {
    const foreign = atomic({
      id: 5,
      code: 'gmv',
      name: '成交额',
      definition: {
        datasource_id: 2,
        table_name: 'orders',
        field_name: 'gmv',
        aggregation: 'SUM',
      },
    });
    const r = matchMetricDefinitions(
      [foreign],
      1,
      '成交额趋势',
      5,
      () => undefined,
      {
        fuzzy: ['atomic:gmv'],
      },
    );
    expect(r.matched).toBe(0);
  });

  it('stays literal-only when no fuzzy keys are supplied', () => {
    const r = matchMetricDefinitions(
      [pay, refund],
      1,
      '支付金额',
      5,
      () => undefined,
    );
    expect(r.matched).toBe(1);
    expect(r.text).not.toContain('refund_amount');
  });

  // --- appended branch-sweep tests -----------------------------------------

  describe('parseMetricDefinition malformed-input arms', () => {
    it('rejects non-object payloads outright', () => {
      expect(parseMetricDefinition('atomic', null)).toBeNull();
      expect(parseMetricDefinition('atomic', 'orders')).toBeNull();
      expect(parseMetricDefinition('period', 7)).toBeNull();
    });

    it('rejects unknown period modes and anchors', () => {
      expect(parseMetricDefinition('period', { mode: 'neither' })).toBeNull();
      expect(
        parseMetricDefinition('period', { mode: 'anchor', anchor: 'nope' }),
      ).toBeNull();
    });

    it('trims a derived time_field and rejects a non-string expression', () => {
      expect(
        parseMetricDefinition('derived', {
          atomic_code: 'a',
          time_field: ' t ',
        }),
      ).toEqual({ atomicCode: 'a', timeField: 't' });
      expect(parseMetricDefinition('composite', { expression: 5 })).toBeNull();
    });
  });

  describe('definitionProblem remaining kinds', () => {
    it('atomic/period/composite have no cross-field problem', () => {
      expect(definitionProblem('atomic', {} as never)).toBeNull();
      expect(definitionProblem('period', {} as never)).toBeNull();
      expect(definitionProblem('composite', {} as never)).toBeNull();
    });

    it('derived without modifierCodes and modifier without values', () => {
      expect(definitionProblem('derived', { atomicCode: 'a' })).toBeNull();
      // hand-corrupted row: values missing entirely → treated as empty
      expect(
        definitionProblem('modifier', {
          datasourceId: 1,
          tableName: 't',
          fieldName: 'f',
          operator: '=',
        } as never),
      ).toBe('metric.def_values_required');
    });
  });

  describe('conditionText remaining operators', () => {
    const def = (operator: string, values: string[]) =>
      ({
        datasourceId: 1,
        tableName: 'orders',
        fieldName: 'status',
        operator,
        values,
      }) as Parameters<typeof conditionText>[0];

    it('renders every operator shape', () => {
      expect(conditionText(def('!=', ['a']))).toBe('orders.status != a');
      expect(conditionText(def('not_in', ['a', 'b']))).toBe(
        'orders.status NOT IN (a, b)',
      );
      expect(conditionText(def('like', ['pay']))).toBe(
        "orders.status LIKE '%pay%'",
      );
      expect(conditionText(def('gt', ['1']))).toBe('orders.status > 1');
      expect(conditionText(def('gte', ['1']))).toBe('orders.status >= 1');
      expect(conditionText(def('lt', ['9']))).toBe('orders.status < 9');
      expect(conditionText(def('lte', ['9']))).toBe('orders.status <= 9');
    });

    it('falls back to an empty value when values is empty', () => {
      // defensive: a hand-corrupted row can still render with values []
      expect(conditionText(def('=', []))).toBe('orders.status = ');
    });
  });

  describe('matching/render helper edges', () => {
    it('matchNames drops non-string aliases', () => {
      expect(matchNames('nm', [1, 'ok', null])).toEqual(['nm', 'ok']);
    });

    it('expressionCodes has no codes for a numbers-only expression', () => {
      expect(expressionCodes('1 + 2.5')).toEqual([]);
    });

    it('expressionProblem bounds: blank, too long, too many tokens, early )', () => {
      expect(expressionProblem('   ', 'x')).toBe('metric.expression_invalid');
      expect(expressionProblem('a' + '+1'.repeat(2001), 'x')).toBe(
        'metric.expression_invalid', // 4003 chars > 4000 cap
      );
      expect(expressionProblem('a' + ' + a'.repeat(100), 'x')).toBe(
        'metric.expression_invalid', // 201 tokens > 200 cap
      );
      expect(expressionProblem(') a + b', 'x')).toBe(
        'metric.expression_invalid', // depth < 0 mid-walk
      );
    });
  });

  describe('renderDerived reference resolution', () => {
    const atomicDef = (datasource_id = 1) => ({
      datasource_id,
      table_name: 'orders',
      field_name: 'pay_amount',
      aggregation: 'SUM',
    });
    const pay = base({
      id: 1,
      kind: 'atomic',
      code: 'pay',
      name: '支付金额',
      definition: atomicDef(),
    });
    const baby = base({
      id: 2,
      kind: 'modifier',
      code: 'baby',
      name: '母婴类',
      definition: {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'category',
        operator: '=',
        values: ['母婴'],
      },
    });
    const last7 = base({
      id: 3,
      kind: 'period',
      code: 'last7',
      name: '最近7天',
      definition: { mode: 'recent', time_unit: 'day', count: 7 },
    });
    const ctxOf = (rows: MetricDefLike[], ds = 1): MetricRenderContext => ({
      rows: effectiveByCode(rows),
      datasourceId: ds,
      timeFieldOf: () => undefined,
    });

    it('returns null for a malformed derived definition', () => {
      const bad = base({
        id: 9,
        kind: 'derived',
        code: 'bad',
        name: '坏',
        definition: {},
      });
      expect(renderDerived(bad, ctxOf([bad]))).toBeNull();
    });

    it('returns null when the referenced atomic belongs to another datasource', () => {
      const foreignAtomic = base({
        ...pay,
        definition: atomicDef(99),
      });
      const d = base({
        id: 10,
        kind: 'derived',
        code: 'd',
        name: 'd',
        definition: { atomic_code: 'pay' },
      });
      expect(renderDerived(d, ctxOf([foreignAtomic, d]))).toBeNull();
    });

    it('returns null on dangling modifier / cross-datasource modifier / dangling period', () => {
      const danglingMod = base({
        id: 11,
        kind: 'derived',
        code: 'd1',
        name: 'd1',
        definition: { atomic_code: 'pay', modifier_codes: ['ghost'] },
      });
      expect(renderDerived(danglingMod, ctxOf([pay, danglingMod]))).toBeNull();

      const foreignMod = base({
        ...baby,
        definition: {
          datasource_id: 99,
          table_name: 'orders',
          field_name: 'category',
          operator: '=',
          values: ['母婴'],
        },
      });
      const crossDsMod = base({
        id: 12,
        kind: 'derived',
        code: 'd2',
        name: 'd2',
        definition: { atomic_code: 'pay', modifier_codes: ['baby'] },
      });
      expect(
        renderDerived(crossDsMod, ctxOf([pay, foreignMod, crossDsMod])),
      ).toBeNull();

      const danglingPeriod = base({
        id: 13,
        kind: 'derived',
        code: 'd3',
        name: 'd3',
        definition: { atomic_code: 'pay', period_code: 'ghost_p' },
      });
      expect(
        renderDerived(danglingPeriod, ctxOf([pay, danglingPeriod])),
      ).toBeNull();
    });

    it('renders without a period and without a time field when none resolve', () => {
      const withMod = base({
        id: 14,
        kind: 'derived',
        code: 'd4',
        name: '母婴支付金额',
        definition: { atomic_code: 'pay', modifier_codes: ['baby'] },
      });
      const out = renderDerived(withMod, ctxOf([pay, baby, withMod]));
      expect(out).not.toBeNull();
      expect(out!.line).toBe(
        '母婴支付金额 (d4): 口径 = SUM(orders.pay_amount); 修饰: orders.category = 母婴',
      );
      expect(out!.line).not.toContain('时间:');

      const withPeriodNoTimeField = base({
        id: 15,
        kind: 'derived',
        code: 'd5',
        name: '近7天支付金额',
        definition: { atomic_code: 'pay', period_code: 'last7' },
      });
      const out2 = renderDerived(
        withPeriodNoTimeField,
        ctxOf([pay, last7, withPeriodNoTimeField]),
      );
      // no time_field on the def and timeFieldOf() → undefined → no 按-clause
      expect(out2!.line).toContain('时间: 最近7天');
      expect(out2!.line).not.toContain('按');
    });
  });

  describe('renderComposite operand/depth arms', () => {
    const pay = base({
      id: 1,
      kind: 'atomic',
      code: 'pay',
      name: '支付金额',
      definition: {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'pay_amount',
        aggregation: 'SUM',
      },
    });
    const ctxOf = (rows: MetricDefLike[], ds = 1): MetricRenderContext => ({
      rows: effectiveByCode(rows),
      datasourceId: ds,
      timeFieldOf: () => undefined,
    });

    it('returns null for malformed defs, code-less expressions and pre-seen rows', () => {
      const malformed = base({
        id: 20,
        kind: 'composite',
        code: 'm',
        name: 'm',
        definition: {},
      });
      expect(renderComposite(malformed, ctxOf([malformed]))).toBeNull();

      const noCodes = base({
        id: 21,
        kind: 'composite',
        code: 'nc',
        name: 'nc',
        definition: { expression: '1 + 2' },
      });
      expect(renderComposite(noCodes, ctxOf([noCodes]))).toBeNull();

      const self = base({
        id: 22,
        kind: 'composite',
        code: 'self',
        name: 'self',
        definition: { expression: 'self + pay' },
      });
      // caller-supplied seen set → cycle guard fires before descending
      expect(
        renderComposite(self, ctxOf([pay, self]), new Set(['composite:self'])),
      ).toBeNull();
    });

    it('returns null past the depth cap (direct + chained)', () => {
      const deep = base({
        id: 23,
        kind: 'composite',
        code: 'deep',
        name: 'deep',
        definition: { expression: 'pay + 1' },
      });
      expect(
        renderComposite(deep, ctxOf([pay, deep]), new Set(), 9),
      ).toBeNull();

      // a 10-composite chain exceeds MAX_COMPOSITE_DEPTH from depth 0
      const chain: MetricDefLike[] = [pay];
      for (let i = 1; i <= 10; i++) {
        chain.push(
          base({
            id: 30 + i,
            kind: 'composite',
            code: `c${i}`,
            name: `c${i}`,
            definition: { expression: i === 10 ? 'pay' : `c${i + 1} + 1` },
          }),
        );
      }
      expect(renderComposite(chain[1], ctxOf(chain))).toBeNull();
    });

    it('returns null on a foreign-datasource atomic operand or a dangling code', () => {
      const foreign = base({
        ...pay,
        id: 2,
        definition: {
          datasource_id: 99,
          table_name: 'orders',
          field_name: 'pay_amount',
          aggregation: 'SUM',
        },
      });
      const usesForeign = base({
        id: 24,
        kind: 'composite',
        code: 'uf',
        name: 'uf',
        definition: { expression: 'pay + 1' },
      });
      expect(
        renderComposite(usesForeign, ctxOf([foreign, usesForeign])),
      ).toBeNull();

      const usesGhost = base({
        id: 25,
        kind: 'composite',
        code: 'ug',
        name: 'ug',
        definition: { expression: 'ghost + pay' },
      });
      expect(renderComposite(usesGhost, ctxOf([pay, usesGhost]))).toBeNull();
    });

    it('clips an operand display name longer than the render-label bound', () => {
      const longName = 'x'.repeat(130);
      const longAtomic = base({
        ...pay,
        name: longName,
      });
      const comp = base({
        id: 26,
        kind: 'composite',
        code: 'clip',
        name: 'clip',
        definition: { expression: 'pay * 2' },
      });
      const out = renderComposite(comp, ctxOf([longAtomic, comp]));
      expect(out).not.toBeNull();
      expect(out!.line).toContain('x'.repeat(119) + '…');
      expect(out!.line).not.toContain(longName);
    });
  });

  describe('matchMetricDefinitions additional guards', () => {
    const pay = base({
      id: 1,
      kind: 'atomic',
      code: 'pay_amount',
      name: '支付金额',
      definition: {
        datasource_id: 1,
        table_name: 'orders',
        field_name: 'pay_amount',
        aggregation: 'SUM',
      },
    });

    it('skips the time part when the matched period row has a malformed definition', () => {
      const brokenPeriod = base({
        id: 2,
        kind: 'period',
        code: 'last7',
        name: '最近7天',
        definition: { mode: 'neither' },
      });
      const r = matchMetricDefinitions(
        [pay, brokenPeriod],
        1,
        '最近7天支付金额',
        5,
        () => undefined,
      );
      expect(r.matched).toBe(1);
      expect(r.text).toContain('支付金额 (pay_amount)');
      expect(r.text).not.toContain('时间:');
    });

    it('renders the matched period without a 按-clause when no time field resolves', () => {
      const validPeriod = base({
        id: 4,
        kind: 'period',
        code: 'last7',
        name: '最近7天',
        definition: { mode: 'recent', time_unit: 'day', count: 7 },
      });
      const r = matchMetricDefinitions(
        [pay, validPeriod],
        1,
        '最近7天支付金额',
        5,
        () => undefined, // no FieldSemantic role=time for the table
      );
      expect(r.matched).toBe(1);
      expect(r.text).toContain('时间: 最近7天');
      expect(r.text).not.toContain('按');
    });

    it('does not re-state an atomic already covered by a rendered derived metric', () => {
      const derived = base({
        id: 3,
        kind: 'derived',
        code: 'dv',
        name: '支付金额衍生',
        definition: { atomic_code: 'pay_amount' },
      });
      const r = matchMetricDefinitions(
        [pay, derived],
        1,
        '支付金额衍生 支付金额',
        5,
        () => undefined,
        { fuzzy: ['atomic:pay_amount'] },
      );
      expect(r.matched).toBe(1);
      expect(r.text).toContain('支付金额衍生 (dv)');
      // the covered atomic is neither re-rendered literally nor via fuzzy
      expect(r.text).not.toContain('(pay_amount)');
    });

    it('does not re-render a literal hit via a fuzzy key', () => {
      const r = matchMetricDefinitions(
        [pay],
        1,
        '支付金额',
        5,
        () => undefined,
        { fuzzy: ['atomic:pay_amount'] },
      );
      expect(r.matched).toBe(1);
      expect(r.text.match(/- /g)).toHaveLength(1);
    });
  });

  describe('namingTemplate optional attributes', () => {
    it('omits category/description attributes when they are null', () => {
      const rows: DataStandardLike[] = [
        {
          id: 9,
          kind: 'naming',
          code: 'biz',
          term: '客户',
          name: '顾客',
          aliases: null,
          category: null,
          description: null,
          scope: 'WORKSPACE',
          oid: 1,
          ownerUid: null,
          enabled: true,
          updatedAt: new Date(),
        },
      ];
      const text = namingTemplate(rows, '客户是谁', 5);
      expect(text).toContain('<rule term="客户" standard="顾客" />');
      expect(text).not.toContain('category=');
      expect(text).not.toContain('description=');
    });
  });
});
