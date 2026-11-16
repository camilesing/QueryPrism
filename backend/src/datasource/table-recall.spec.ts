// Spec for the table-recall pure functions.
import {
  calcKeywordScore,
  longestMentions,
  matchSuggestedTableIds,
  mentionSpans,
  needsClarify,
  rankTables,
  selectTables,
  type KeywordField,
} from './table-recall';

describe('calcKeywordScore', () => {
  it('full table-name match → 1.0 (case-insensitive, among other keywords)', () => {
    expect(calcKeywordScore('sales_order', 'sales_order', '销售订单', [])).toBe(
      1,
    );
    expect(calcKeywordScore('Sales_Order', 'sales_order', '', [])).toBe(1);
    expect(
      calcKeywordScore('sales_order,本月,销售额', 'sales_order', '', []),
    ).toBe(1);
  });

  it('full comment match → 0.9; caller-merged custom comment is authoritative', () => {
    expect(calcKeywordScore('销售订单', 'so_header', '销售订单', [])).toBe(0.9);
    expect(calcKeywordScore('销售订单', 'so_header', '自定义备注', [])).toBe(0);
  });

  it('partial table-name match scales with part coverage', () => {
    // "sales" covers 1/2 of sales_order → 0.25 + 0.25*0.5 = 0.375 → 0.38
    expect(calcKeywordScore('sales', 'sales_order', '', [])).toBe(0.38);
    // full part coverage → 0.5
    expect(calcKeywordScore('sales,order', 'sales_order', '', [])).toBe(0.5);
    // 1/3 of sales_order_detail → ≈0.33
    const s = calcKeywordScore('sales', 'sales_order_detail', '', []);
    expect(s).toBeGreaterThanOrEqual(0.3);
    expect(s).toBeLessThanOrEqual(0.35);
  });

  it('field comment exact → 0.5, custom takes precedence over synced', () => {
    expect(
      calcKeywordScore('销售额', 'daily_report', '日报表', [
        { fieldName: 'id', fieldComment: '主键' },
        { fieldName: 'order_amount', fieldComment: '订单金额' },
        { fieldName: 'sales_amount', fieldComment: '销售额' },
      ]),
    ).toBe(0.5);
    // custom comment wins over field_comment
    expect(
      calcKeywordScore('销售额', 't', '', [
        { fieldName: 'amount', fieldComment: '其他', customComment: '销售额' },
      ]),
    ).toBe(0.5);
  });

  it('field name part match → 0.3 (underscored names split)', () => {
    expect(
      calcKeywordScore('order', 'stats', '', [
        { fieldName: 'customer_order_count' },
      ]),
    ).toBe(0.3);
  });

  it('keyword coverage multiplies the best score', () => {
    // both keywords hit the table name parts (0.5) → best 0.5 × coverage 1
    expect(calcKeywordScore('sales,order', 'sales_order', '', [])).toBe(0.5);
    // one of two keywords hits (field name 0.3) → 0.3 × 0.5 = 0.15
    expect(
      calcKeywordScore('order,客户', 'stats', '', [
        { fieldName: 'customer_order_count' },
      ]),
    ).toBe(0.15);
  });

  it('no match / empty inputs → 0', () => {
    expect(calcKeywordScore('销售额', 'users', '用户表', [])).toBe(0);
    expect(calcKeywordScore('', 'users', '', [])).toBe(0);
    expect(calcKeywordScore(' , ,', 'users', '', [])).toBe(0);
  });
});

describe('mentionSpans / longestMentions', () => {
  it('matches at identifier boundaries, adjacent Chinese allowed', () => {
    // "order" inside "sales_order" must NOT count as a bare mention
    const spans = mentionSpans('查询 sales_order 的订单', 'order');
    expect(spans).toHaveLength(0);
    expect(mentionSpans('查询order的订单', 'order')).toHaveLength(1);
  });

  it('keeps the longest overlapping mention plus independent short ones', () => {
    const spansByName = new Map<string, Array<[number, number]>>([
      // "订单明细"（较长）与 "订单" 在同一起点重叠
      ['订单明细', mentionSpans('查询订单明细', '订单明细')],
      ['订单', mentionSpans('查询订单明细，再看订单', '订单')],
    ]);
    const names = longestMentions(spansByName);
    expect(names.has('订单明细')).toBe(true);
    expect(names.has('订单')).toBe(true); // the second, non-overlapping mention
  });
});

describe('selectTables (explicit-mention retention)', () => {
  const mk = (id: number, tableName: string, comment = '') => ({
    id,
    tableName,
    comment,
  });

  it('an explicitly named table survives the count cut and ranks first', () => {
    const ranked = [
      mk(1, 'distractor_1'),
      mk(2, 'distractor_2'),
      mk(3, 'sales_order'),
      mk(4, 'distractor_3'),
    ];
    const out = selectTables(ranked, '查 sales_order 表最近的订单', 2);
    expect(out.map((t) => t.tableName)).toEqual([
      'sales_order',
      'distractor_1',
    ]);
  });

  it('a full-comment mention retains the table too', () => {
    const ranked = [mk(1, 'a'), mk(2, 'b', '销售订单'), mk(3, 'c')];
    const out = selectTables(ranked, '查询销售订单的金额', 1);
    expect(out.map((t) => t.tableName)).toEqual(['b']);
  });

  it('quoted identifiers match whole names; unknown quoted text never leaks parts', () => {
    const ranked = [mk(1, 'sales'), mk(2, 'sales-order'), mk(3, 'other')];
    const out = selectTables(ranked, '查询 "sales-order"', 1);
    expect(out.map((t) => t.tableName)).toEqual(['sales-order']);
    // "sales" alone is NOT mentioned — the quoted span shadows it
    const out2 = selectTables(ranked, '查询 "sales"', 1);
    expect(out2.map((t) => t.tableName)).toEqual(['sales']);
  });

  it('fills remaining slots in rank order after required tables', () => {
    const ranked = [mk(1, 'a'), mk(2, 'sales_order'), mk(3, 'c'), mk(4, 'd')];
    const out = selectTables(ranked, '查 sales_order', 3);
    expect(out.map((t) => t.id)).toEqual([2, 1, 3]);
  });
});

describe('rankTables (fusion)', () => {
  const cand = (
    id: number,
    tableName: string,
    vectorScore: number,
    keywordScore: number,
  ) => ({ id, tableName, comment: '', vectorScore, keywordScore });

  it('fuses α·vector + (1-α)·keyword; exact keyword hits rank first', () => {
    // α=0.4: far=[0.4*0.9+0.6*0=0.36], named=[0.4*0.1+0.6*1=0.64]
    const out = rankTables(
      [
        cand(1, 'far', 0.9, 0),
        cand(2, 'named', 0.1, 1),
        cand(3, 'mid', 0.5, 0.2),
      ],
      '查 named',
      { alpha: 0.4, count: 3 },
    );
    expect(out.map((t) => t.tableName)).toEqual(['named', 'far', 'mid']);
  });

  it('applies the explicit-mention cut after fusion', () => {
    const tables = Array.from({ length: 19 }, (_, i) =>
      cand(i, `step_${i}`, 0.9, 0),
    );
    tables.push(cand(99, 'procurement', 0.2, 0));
    const out = rankTables(tables, '查询procurement的采购金额', {
      alpha: 0.4,
      count: 10,
    });
    expect(out).toHaveLength(10);
    expect(out[0].tableName).toBe('procurement');
  });

  it('a vector-only pass (all keyword scores 0) still retains explicit tables', () => {
    const out = rankTables(
      [
        cand(1, 'a', 0.9, 0),
        cand(2, 'sales_order', 0.05, 0),
        cand(3, 'b', 0.8, 0),
      ],
      '查 sales_order',
      { alpha: 0.4, count: 2 },
    );
    expect(out.map((t) => t.tableName)).toEqual(['sales_order', 'a']);
  });
});

describe('needsClarify (clarify gate)', () => {
  // The pool a clarify question offers: 4 tables, none mentioned.
  const pool = [
    { id: 1, tableName: 'sales_order', comment: '销售订单' },
    { id: 2, tableName: 'crm_customer', comment: '客户信息' },
    { id: 3, tableName: 'inv_stock', comment: '库存记录' },
    { id: 4, tableName: 'fin_payment', comment: '支付流水' },
  ];
  const gate = (rounds = 0, extra = {}) => ({
    enabled: true,
    tableThreshold: 3,
    rounds,
    maxRounds: 1,
    ...extra,
  });

  it('asks when candidates reach the threshold and nothing is mentioned', () => {
    expect(needsClarify(pool, '统计一下整体情况', gate())).toBe(true);
  });

  it('does not ask below the threshold', () => {
    expect(needsClarify(pool.slice(0, 2), '统计一下整体情况', gate())).toBe(
      false,
    );
  });

  it('does not ask when the question explicitly names a table (or comment)', () => {
    expect(needsClarify(pool, '查一下sales_order的金额', gate())).toBe(false);
    // full-comment mention also counts as explicit
    expect(needsClarify(pool, '看看销售订单有多少', gate())).toBe(false);
  });

  it('does not ask when the round budget is spent (max rounds)', () => {
    expect(needsClarify(pool, '统计一下整体情况', gate(1))).toBe(false);
  });

  it('keeps asking while a multi-round budget has room', () => {
    const multi = gate(0, { maxRounds: 2 });
    expect(needsClarify(pool, '统计一下整体情况', multi)).toBe(true);
    expect(
      needsClarify(pool, '统计一下整体情况', { ...multi, rounds: 1 }),
    ).toBe(true);
    expect(
      needsClarify(pool, '统计一下整体情况', { ...multi, rounds: 2 }),
    ).toBe(false);
  });

  it('does not ask when the gate is disabled', () => {
    expect(
      needsClarify(pool, '统计一下整体情况', gate(0, { enabled: false })),
    ).toBe(false);
  });

  it('empty question never triggers (degenerate input)', () => {
    expect(needsClarify(pool, '', gate())).toBe(false);
  });
});

describe('matchSuggestedTableIds (need_clarify tables)', () => {
  const candidates = [
    { id: 1, tableName: 'sales_order', comment: '销售订单' },
    { id: 2, tableName: 'crm_customer', comment: '客户信息' },
    { id: 3, tableName: 'inv_stock', comment: '库存记录' },
  ];

  it('matches case-insensitively, strips quotes and schema prefixes', () => {
    expect(
      matchSuggestedTableIds(
        [
          'CRM_CUSTOMER',
          '`sales_order`',
          'public.inv_stock',
          '"public"."sales_order"',
        ],
        candidates,
      ),
    ).toEqual([2, 1, 3]);
  });

  it('drops unknown names and de-duplicates while keeping LLM order', () => {
    expect(
      matchSuggestedTableIds(
        ['missing', 'inv_stock', 'INV_STOCK', 'sales_order'],
        candidates,
      ),
    ).toEqual([3, 1]);
  });

  it('returns [] when nothing matches', () => {
    expect(matchSuggestedTableIds(['nope'], candidates)).toEqual([]);
  });

  it('skips suggested names and candidates that normalize to empty', () => {
    // a suggested entry that is blank after trim/quote-stripping is skipped
    expect(
      matchSuggestedTableIds(['  ', '``', 'sales_order'], candidates),
    ).toEqual([1]);
    // a candidate whose tableName strips to empty never enters the lookup map
    expect(
      matchSuggestedTableIds(
        ['sales_order'],
        [...candidates, { id: 9, tableName: '``', comment: '' }],
      ),
    ).toEqual([1]);
  });

  it('keeps the first candidate when two share a normalized name', () => {
    // duplicate candidate names: the second never overwrites the first
    expect(
      matchSuggestedTableIds(
        ['dup'],
        [
          { id: 1, tableName: 'dup', comment: '' },
          { id: 2, tableName: 'DUP', comment: '' },
        ],
      ),
    ).toEqual([1]);
  });
});

// ───────────────────── residual branch arms (coverage tail) ────────────────

describe('edge inputs (coverage tail)', () => {
  it('mentionSpans returns [] for an empty name', () => {
    expect(mentionSpans('any question', '')).toEqual([]);
  });

  it('selectTables tolerates an empty question and blank table names', () => {
    const ranked = [
      { id: 1, tableName: '', comment: '' },
      { id: 2, tableName: 'a', comment: '' },
    ];
    // empty question → nothing explicitly mentioned, rank order preserved
    expect(selectTables(ranked, '', 2).map((t) => t.id)).toEqual([1, 2]);
    // a blank-named candidate is never treated as mentioned (name '' is not
    // inserted into the mention maps)
    expect(selectTables(ranked, '查', 2).map((t) => t.id)).toEqual([1, 2]);
  });

  it('duplicate candidate names are mentioned together (first wins the map)', () => {
    const ranked = [
      { id: 1, tableName: 'orders', comment: '' },
      { id: 2, tableName: 'orders', comment: '' },
      { id: 3, tableName: 'x', comment: '' },
    ];
    const out = selectTables(ranked, '查 orders', 1);
    // BOTH duplicate-named rows are explicit mentions (set keyed by name)
    expect(out.map((t) => t.id)).toEqual([1, 2]);
  });

  it('calcKeywordScore tolerates blank table names and missing fields', () => {
    // tableName '' → tn '' and empty tnParts; keyword falls through to 0
    expect(calcKeywordScore('销售', '', '', [])).toBe(0);
    // fields undefined / null → treated as []
    expect(
      calcKeywordScore(
        '用户表',
        'users',
        '用户表',
        undefined as unknown as KeywordField[],
      ),
    ).toBe(0.9);
    expect(
      calcKeywordScore(
        '用户表',
        'users',
        '用户表',
        null as unknown as KeywordField[],
      ),
    ).toBe(0.9);
    // a field with an empty fieldName contributes no name parts
    expect(
      calcKeywordScore('订单', 'so', '', [
        { fieldName: '', fieldComment: '订单' },
      ]),
    ).toBe(0.5);
    // blank tableName AND a scoring keyword: the tnParts block is skipped
    // entirely (size 0) yet the field-comment score survives
    expect(
      calcKeywordScore('订单', '', '', [
        { fieldName: '', fieldComment: '订单' },
      ]),
    ).toBe(0.5);
  });

  it('keyword inside table comment (not equal) scores 0.7', () => {
    expect(calcKeywordScore('销售', 'so', '销售订单', [])).toBe(0.7);
    // a repeated keyword re-reads the existing map entry on the 0.7 arm
    expect(calcKeywordScore('销售,销售', 'so', '销售订单', [])).toBe(0.35);
  });

  it('keyword substring of a field comment scores 0.4 (no break, re-reads map)', () => {
    // two field comments both containing the keyword → second pass finds the
    // existing 0.4 entry and keeps the max
    expect(
      calcKeywordScore('金额', 't', '', [
        { fieldName: 'a', fieldComment: '订单金额' },
        { fieldName: 'b', fieldComment: '退款金额' },
      ]),
    ).toBe(0.4);
  });

  it('a partial table-name score never lowers an existing field-comment score', () => {
    // 'sales' matches both a table-name part (0.38) and a field comment (0.5)
    // — the later tnScore pass re-reads the stored 0.5 and keeps it
    expect(
      calcKeywordScore('sales', 'sales_order', '', [
        { fieldName: 'x', fieldComment: 'sales' },
      ]),
    ).toBe(0.5);
  });
});
