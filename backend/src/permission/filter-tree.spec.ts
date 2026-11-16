// filter-tree spec — unit tests for the row-permission expression-tree →
// SQL WHERE fragment evaluator (design notes documented in filter-tree.ts).
// Pure functions + a plain field-map; no NestJS DI.
import {
  DENY_FRAGMENT,
  escapeLikeValue,
  escapeSqlValue,
  transFilterTerm,
  quoteIdentifier,
  transFilterTree,
  transTreeToWhere,
  transTreeItem,
  type FilterEvalContext,
  type FilterTree,
} from './filter-tree';

/** Build an eval context backed by a flat `{id → fieldName}` map (the prod
 *  fieldLookup is Prisma-backed; tests use a plain object). */
function ctx(
  fields: Record<number, string>,
  dsType = 'sqlite',
): FilterEvalContext {
  return {
    ds: { type: dsType },
    fieldLookup: (id: number) => {
      const fieldName = fields[id];
      return fieldName === undefined ? null : { fieldName };
    },
  };
}

describe('escapeSqlValue', () => {
  it('doubles single quotes (standard SQL escaping)', () => {
    expect(escapeSqlValue("O'Brien")).toBe("O''Brien");
  });
  it('doubles backslashes for mysql (its literals treat \\ as escape)', () => {
    expect(escapeSqlValue('a\\b', 'mysql')).toBe('a\\\\b');
  });
  it('leaves backslashes alone for postgresql/sqlite (standard strings)', () => {
    expect(escapeSqlValue('a\\b', 'postgresql')).toBe('a\\b');
    expect(escapeSqlValue('a\\b', 'sqlite')).toBe('a\\b');
    expect(escapeSqlValue('a\\b')).toBe('a\\b'); // no engine → no doubling
  });
  it('handles mixed quotes and backslashes (mysql)', () => {
    expect(escapeSqlValue("\\'", 'mysql')).toBe("\\\\''");
  });
  it('leaves safe strings untouched', () => {
    expect(escapeSqlValue('plain_value 123')).toBe('plain_value 123');
  });
});

describe('transFilterTerm', () => {
  it.each([
    ['eq', ' = '],
    ['not_eq', ' <> '],
    ['lt', ' < '],
    ['le', ' <= '],
    ['gt', ' > '],
    ['ge', ' >= '],
    ['in', ' IN '],
    ['not in', ' NOT IN '], // SPACE, not underscore
    ['like', ' LIKE '],
    ['not like', ' NOT LIKE '], // SPACE, not underscore
    ['null', ' IS NULL '],
    ['not_null', ' IS NOT NULL '],
    ['empty', ' = '],
    ['not_empty', ' <> '],
    ['between', ' BETWEEN '],
  ])('maps %s → %j', (term, expected) => {
    expect(transFilterTerm(term)).toBe(expected);
  });
  it('returns empty string for an unknown term (no injection vector)', () => {
    expect(transFilterTerm('DROP')).toBe('');
  });
});

describe('quoteIdentifier (engine-specific quoting)', () => {
  it('wraps with backticks for mysql', () => {
    expect(quoteIdentifier('age', 'mysql')).toBe('`age`');
  });
  it('wraps with double quotes for postgresql', () => {
    expect(quoteIdentifier('age', 'postgresql')).toBe('"age"');
  });
  it('wraps with double quotes for sqlite', () => {
    expect(quoteIdentifier('age', 'sqlite')).toBe('"age"');
  });
  it('defaults to double quotes for unknown engines', () => {
    expect(quoteIdentifier('age', 'oracle')).toBe('"age"');
  });
  it('DOUBLES an embedded double quote (injection guard, §116.6a)', () => {
    expect(quoteIdentifier('a"b', 'sqlite')).toBe('"a""b"');
    expect(quoteIdentifier('x" OR 1=1 --', 'postgresql')).toBe(
      '"x"" OR 1=1 --"',
    );
  });
  it('DOUBLES an embedded backtick for mysql (injection guard)', () => {
    expect(quoteIdentifier('a`b', 'mysql')).toBe('`a``b`');
    expect(quoteIdentifier('x` OR 1=1 --', 'mysql')).toBe('`x`` OR 1=1 --`');
  });
});

describe('transTreeItem (leaf condition)', () => {
  it("builds `field = 'value'` for an eq term", () => {
    const c = ctx({ 10: 'age' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      value: '18',
    } as const;
    expect(transTreeItem(item, c)).toBe("`age` = '18'");
  });
  it("builds `field IN ('a','b')` for an in term with comma-separated value", () => {
    const c = ctx({ 10: 'name' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'in',
      value: 'a,b',
    } as const;
    expect(transTreeItem(item, c)).toBe("`name` IN ('a','b')");
  });
  it("builds `field LIKE '%kw%' ESCAPE ...` for a like term (§116.6d)", () => {
    const c = ctx({ 10: 'name' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'like',
      value: 'john',
    } as const;
    expect(transTreeItem(item, c)).toBe("`name` LIKE '%john%' ESCAPE '\\\\'");
    const pg = ctx({ 10: 'name' }, 'postgresql');
    expect(transTreeItem(item, pg)).toBe(`"name" LIKE '%john%' ESCAPE '\\'`);
  });
  it('escapes LIKE wildcards in the value so they match literally', () => {
    const c = ctx({ 10: 'name' }, 'sqlite');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'like',
      value: '50%_off\\x',
    } as const;
    expect(transTreeItem(item, c)).toBe(
      `"name" LIKE '%50\\%\\_off\\\\x%' ESCAPE '\\'`,
    );
  });
  it("builds `field BETWEEN 'a' AND 'b'` (§116.4 two-operand fix)", () => {
    const c = ctx({ 10: 'age' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'between',
      value: '18, 30',
    } as const;
    expect(transTreeItem(item, c)).toBe("`age` BETWEEN '18' AND '30'");
  });
  it('DENIES a between term without exactly two operands', () => {
    const c = ctx({ 10: 'age' }, 'mysql');
    for (const value of ['18', '1,2,3', '1,']) {
      const item = {
        type: 'item',
        field_id: 10,
        term: 'between',
        value,
      } as const;
      expect(transTreeItem(item, c)).toBe(DENY_FRAGMENT);
    }
  });
  it('builds `field IS NULL` (no value) for a null term', () => {
    const c = ctx({ 10: 'email' }, 'postgresql');
    const item = { type: 'item', field_id: 10, term: 'null' } as const;
    expect(transTreeItem(item, c)).toBe('"email" IS NULL ');
  });
  it("builds `field = ''` for an empty term", () => {
    const c = ctx({ 10: 'note' }, 'sqlite');
    const item = { type: 'item', field_id: 10, term: 'empty' } as const;
    expect(transTreeItem(item, c)).toBe('"note" = \'\'');
  });
  it("builds `(field IN ('x','y'))` for an enum filter_type", () => {
    const c = ctx({ 10: 'status' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      filter_type: 'enum',
      enum_value: ['x', 'y'],
    } as const;
    expect(transTreeItem(item, c)).toBe("(`status` IN ('x','y'))");
  });
  it("builds `(field NOT IN ('x','y'))` for an enum with term 'not in' (§116.6c)", () => {
    const c = ctx({ 10: 'status' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'not in',
      filter_type: 'enum',
      enum_value: ['x', 'y'],
    } as const;
    expect(transTreeItem(item, c)).toBe("(`status` NOT IN ('x','y'))");
  });
  it('escapes single quotes inside values', () => {
    const c = ctx({ 10: 'name' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      value: "O'Brien",
    } as const;
    expect(transTreeItem(item, c)).toBe("`name` = 'O''Brien'");
  });
  it('DENIES when the field id is unknown (§116.6b fail-closed)', () => {
    const c = ctx({ 10: 'age' });
    const item = {
      type: 'item',
      field_id: 999,
      term: 'eq',
      value: '1',
    } as const;
    expect(transTreeItem(item, c)).toBe(DENY_FRAGMENT);
  });
  it("resolves value_type==='variable' through resolveVariable", () => {
    const c = ctx({ 10: 'name' });
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      value_type: 'variable',
      variable_id: 1,
    } as const;
    expect(
      transTreeItem(item, { ...c, resolveVariable: () => ['alice'] }),
    ).toBe(`"name" = 'alice'`);
  });
  it('DENIES a variable item when the resolver is absent/unresolvable', () => {
    const c = ctx({ 10: 'name' });
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      value_type: 'variable',
      variable_id: 1,
    } as const;
    expect(transTreeItem(item, c)).toBe(DENY_FRAGMENT);
    expect(transTreeItem(item, { ...c, resolveVariable: () => null })).toBe(
      DENY_FRAGMENT,
    );
    expect(transTreeItem(item, { ...c, resolveVariable: () => [] })).toBe(
      DENY_FRAGMENT,
    );
  });
  it("renders a variable 'in' list as multiple quoted values", () => {
    const c = ctx({ 10: 'dept' });
    const item = {
      type: 'item',
      field_id: 10,
      term: 'in',
      value_type: 'variable',
      variable_id: 1,
    } as const;
    expect(
      transTreeItem(item, {
        ...c,
        resolveVariable: () => ['sales', 'hr'],
      }),
    ).toBe(`"dept" IN ('sales','hr')`);
  });
  it('DENIES an enum filter_type with no values', () => {
    const c = ctx({ 10: 'status' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      filter_type: 'enum',
      enum_value: [],
    } as const;
    expect(transTreeItem(item, c)).toBe(DENY_FRAGMENT);
  });
});

describe('escapeLikeValue (LIKE pattern body)', () => {
  it('escapes backslash, quote, % and _ literally', () => {
    expect(escapeLikeValue('a\\b')).toBe('a\\\\b');
    expect(escapeLikeValue("o'x")).toBe("o''x");
    expect(escapeLikeValue('50%')).toBe('50\\%');
    expect(escapeLikeValue('a_b')).toBe('a\\_b');
  });
  it('leaves plain text untouched', () => {
    expect(escapeLikeValue('john')).toBe('john');
  });
});

describe('transTreeToWhere (logic grouping)', () => {
  it('wraps a single item in parens', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const tree: FilterTree = {
      logic: 'AND',
      items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
    };
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1')");
  });
  it('AND-joins two items', () => {
    const c = ctx({ 10: 'a', 11: 'b' }, 'mysql');
    const tree: FilterTree = {
      logic: 'AND',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        { type: 'item', field_id: 11, term: 'gt', value: '5' },
      ],
    };
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1' AND `b` > '5')");
  });
  it('OR-joins two items', () => {
    const c = ctx({ 10: 'a', 11: 'b' }, 'mysql');
    const tree: FilterTree = {
      logic: 'OR',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        { type: 'item', field_id: 11, term: 'eq', value: '2' },
      ],
    };
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1' OR `b` = '2')");
  });
  it('returns null for an empty items list', () => {
    const c = ctx({}, 'mysql');
    const tree: FilterTree = { logic: 'AND', items: [] };
    expect(transTreeToWhere(tree, c)).toBeNull();
  });
  it('returns null for an invalid logic op (injection guard)', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const tree = {
      logic: 'OR; DROP--',
      items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
    } as unknown as FilterTree;
    expect(transTreeToWhere(tree, c)).toBeNull();
  });
  it('DENIES items whose field is missing instead of skipping (§116.6b)', () => {
    const c = ctx({ 10: 'a' }, 'mysql'); // 11 missing
    const tree: FilterTree = {
      logic: 'AND',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        { type: 'item', field_id: 11, term: 'eq', value: '2' },
      ],
    };
    // The restriction cannot silently vanish — the unrenderable leaf denies.
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1' AND (1 = 0))");
  });
  it('recurses into a type:tree child via sub_tree', () => {
    const c = ctx({ 10: 'a', 11: 'b', 12: 'c' }, 'mysql');
    const tree: FilterTree = {
      logic: 'AND',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        {
          type: 'tree',
          sub_tree: {
            logic: 'OR',
            items: [
              { type: 'item', field_id: 11, term: 'eq', value: '2' },
              { type: 'item', field_id: 12, term: 'eq', value: '3' },
            ],
          },
        },
      ],
    };
    expect(transTreeToWhere(tree, c)).toBe(
      "(`a` = '1' AND (`b` = '2' OR `c` = '3'))",
    );
  });
});

describe('transFilterTree (AND-join across multiple trees)', () => {
  it('returns null for an empty tree list', () => {
    expect(transFilterTree([], ctx({}, 'mysql'))).toBeNull();
  });
  it('returns a single tree WHERE unchanged', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const trees: FilterTree[] = [
      {
        logic: 'AND',
        items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
      },
    ];
    expect(transFilterTree(trees, c)).toBe("(`a` = '1')");
  });
  it("AND-joins two trees' fragments", () => {
    const c = ctx({ 10: 'a', 11: 'b' }, 'mysql');
    const trees: FilterTree[] = [
      {
        logic: 'AND',
        items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
      },
      {
        logic: 'AND',
        items: [{ type: 'item', field_id: 11, term: 'gt', value: '5' }],
      },
    ];
    expect(transFilterTree(trees, c)).toBe("(`a` = '1') AND (`b` > '5')");
  });
  it('skips trees that evaluate to null', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const trees: FilterTree[] = [
      {
        logic: 'AND',
        items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
      },
      { logic: 'AND', items: [] }, // null → skipped
    ];
    expect(transFilterTree(trees, c)).toBe("(`a` = '1')");
  });
});

// ─────────────── residual branch arms (coverage tail) ──────────────────────

describe('filter-tree — residual arms (coverage tail)', () => {
  it('escapeSqlValue maps null/undefined to an empty string', () => {
    expect(escapeSqlValue(null)).toBe('');
    expect(escapeSqlValue(undefined)).toBe('');
  });

  it('transFilterTree skips null tree entries', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const trees = [
      null, // corrupted row → skipped
      {
        logic: 'AND',
        items: [{ type: 'item', field_id: 10, term: 'eq', value: '1' }],
      },
    ] as unknown as FilterTree[];
    expect(transFilterTree(trees, c)).toBe("(`a` = '1')");
  });

  it('transTreeToWhere returns null for a null tree', () => {
    expect(
      transTreeToWhere(null as unknown as FilterTree, ctx({}, 'mysql')),
    ).toBeNull();
  });

  it('a subtree that yields null is dropped from the parent group', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const tree: FilterTree = {
      logic: 'AND',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        // empty subtree → null → NOT pushed (no dangling AND)
        { type: 'tree', sub_tree: { logic: 'AND', items: [] } },
      ],
    };
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1')");
  });

  it('DENIES an enum filter_type whose enum_value key is missing', () => {
    const c = ctx({ 10: 'status' }, 'mysql');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'eq',
      filter_type: 'enum',
    } as const;
    expect(transTreeItem(item, c)).toBe(DENY_FRAGMENT);
  });

  it('a variable LIKE uses the first resolved value as the pattern', () => {
    const c = ctx({ 10: 'name' }, 'sqlite');
    const item = {
      type: 'item',
      field_id: 10,
      term: 'like',
      value_type: 'variable',
      variable_id: 1,
    } as const;
    expect(
      transTreeItem(item, { ...c, resolveVariable: () => ['bob', 'amy'] }),
    ).toBe(`"name" LIKE '%bob%' ESCAPE '\\'`);
  });
});

describe('filter-tree — degenerate shapes (coverage tail)', () => {
  it('transFilterTree returns null when every tree yields null', () => {
    const c = ctx({}, 'mysql');
    const trees: FilterTree[] = [{ logic: 'AND', items: [] }];
    expect(transFilterTree(trees, c)).toBeNull();
  });

  it('transTreeToWhere treats a missing items list as empty', () => {
    expect(
      transTreeToWhere({ logic: 'AND' } as FilterTree, ctx({}, 'mysql')),
    ).toBeNull();
  });

  it('a tree child without sub_tree is skipped', () => {
    const c = ctx({ 10: 'a' }, 'mysql');
    const tree: FilterTree = {
      logic: 'AND',
      items: [
        { type: 'item', field_id: 10, term: 'eq', value: '1' },
        { type: 'tree' } as never, // corrupted child → skipped
      ],
    };
    expect(transTreeToWhere(tree, c)).toBe("(`a` = '1')");
  });
});
