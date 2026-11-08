// terminology-snake-mapper unit tests — Phase 10c cycle 4 §82/§88/§100. The
// mapper is a pure function; the service pre-builds the three lookup maps
// (otherWordsMap / datasourceNamesMap / advancedAppNamesMap) and passes them
// in, mirroring cycle 3 audit's oidNameMap pattern.
import {
  toTerminologySnake,
  type TerminologyRow,
} from './terminology-snake-mapper';

function row(
  partial: Partial<TerminologyRow> & { id: number; word: string },
): TerminologyRow {
  return {
    description: null,
    specificDs: false,
    datasourceIds: null,
    enabled: true,
    advancedApplication: null,
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    ...partial,
  };
}

describe('toTerminologySnake', () => {
  it('maps every field with create_time as epoch-ms', () => {
    const r = row({
      id: 5,
      word: '收入',
      description: '营收定义',
      specificDs: true,
      datasourceIds: [1, 2],
      enabled: false,
    });
    const snake = toTerminologySnake(
      r,
      new Map([[5, ['营收', 'revenue']]]),
      new Map([
        [1, 'sales'],
        [2, 'hr'],
      ]),
      new Map(),
    );
    expect(snake.id).toBe(5);
    expect(snake.word).toBe('收入');
    expect(snake.description).toBe('营收定义');
    expect(snake.other_words).toEqual(['营收', 'revenue']);
    expect(snake.specific_ds).toBe(true);
    expect(snake.datasource_ids).toEqual([1, 2]);
    expect(snake.datasource_names).toEqual(['sales', 'hr']);
    expect(snake.enabled).toBe(false);
    expect(snake.advanced_application).toBeNull();
    expect(snake.advanced_application_name).toBeNull();
    expect(snake.create_time).toBe(
      new Date('2026-07-25T10:00:00.000Z').getTime(),
    );
  });

  it('returns other_words [] when the parent has no children in the map', () => {
    const snake = toTerminologySnake(
      row({ id: 9, word: 'solo' }),
      new Map(),
      new Map(),
      new Map(),
    );
    expect(snake.other_words).toEqual([]);
  });

  it('resolves datasource_names by datasource_ids, dropping unknown ids', () => {
    const r = row({
      id: 1,
      word: 'w',
      specificDs: true,
      datasourceIds: [10, 20, 30],
    });
    const snake = toTerminologySnake(
      r,
      new Map(),
      new Map([
        [10, 'sales'],
        [30, 'ops'],
      ]),
      new Map(),
    );
    // 20 is missing from the map → dropped; order preserved from datasource_ids.
    expect(snake.datasource_names).toEqual(['sales', 'ops']);
  });

  it('returns datasource_ids/names [] when datasourceIds is null', () => {
    const snake = toTerminologySnake(
      row({ id: 1, word: 'w', datasourceIds: null }),
      new Map(),
      new Map(),
      new Map(),
    );
    expect(snake.datasource_ids).toEqual([]);
    expect(snake.datasource_names).toEqual([]);
  });

  it('coerces advancedApplication string→number and resolves the name from the map', () => {
    const r = row({ id: 1, word: 'w', advancedApplication: '7' });
    const snake = toTerminologySnake(
      r,
      new Map(),
      new Map(),
      new Map([[7, '高级助手']]),
    );
    expect(snake.advanced_application).toBe(7);
    expect(snake.advanced_application_name).toBe('高级助手');
  });

  it('returns null advanced_application when the column is null or empty string', () => {
    const r1 = row({ id: 1, word: 'w', advancedApplication: null });
    const r2 = row({ id: 2, word: 'w', advancedApplication: '' });
    const emptyStr: Map<number, string> = new Map();
    expect(
      toTerminologySnake(r1, new Map(), emptyStr, emptyStr)
        .advanced_application,
    ).toBeNull();
    expect(
      toTerminologySnake(r2, new Map(), emptyStr, emptyStr)
        .advanced_application,
    ).toBeNull();
  });

  it('falls back to null advanced_application_name when the id is not in the map', () => {
    const r = row({ id: 1, word: 'w', advancedApplication: '99' });
    const snake = toTerminologySnake(
      r,
      new Map(),
      new Map(),
      new Map([[7, 'x']]),
    );
    expect(snake.advanced_application).toBe(99);
    expect(snake.advanced_application_name).toBeNull();
  });
});
