// custom-prompt-snake-mapper spec — verifies the
// snake_case wire shape the frontend (api/prompt.ts + views/system/
// prompt/index.vue) reads. The mapper is a pure function; the service pre-builds
// the datasourceNamesMap + advancedAppNamesMap so the mapper stays pure (mirrors
// terminology-snake-mapper).
import {
  toCustomPromptSnake,
  type CustomPromptRow,
} from './custom-prompt-snake-mapper';

function row(
  partial: Partial<CustomPromptRow> & { id: number; type: string },
): CustomPromptRow {
  return {
    oid: 1,
    name: 'my prompt',
    prompt: 'SELECT * FROM {{table}}',
    specificDs: false,
    datasourceIds: null,
    advancedApplication: null,
    createTime: new Date('2026-07-26T00:00:00Z'),
    ...partial,
  };
}

describe('toCustomPromptSnake', () => {
  const dsMap = new Map<number, string>([
    [1, 'orders'],
    [2, 'users'],
    [3, 'products'],
  ]);
  const advMap = new Map<number, string>([
    [10, 'Advanced App A'],
    [11, 'Advanced App B'],
  ]);

  it('emits all 11 snake fields with correct values + types', () => {
    const out = toCustomPromptSnake(
      row({
        id: 5,
        oid: 7,
        type: 'GENERATE_SQL',
        name: 'sql prompt',
        prompt: 'Generate SQL for {{table}}',
        specificDs: true,
        datasourceIds: [1, 2],
        advancedApplication: '10',
        createTime: new Date('2026-07-26T12:00:00Z'),
      }),
      dsMap,
      advMap,
    );
    expect(out).toEqual({
      id: 5,
      oid: 7,
      type: 'GENERATE_SQL',
      create_time: Date.parse('2026-07-26T12:00:00Z'),
      name: 'sql prompt',
      prompt: 'Generate SQL for {{table}}',
      specific_ds: true,
      datasource_ids: [1, 2],
      datasource_names: ['orders', 'users'],
      advanced_application: 10, // coerced from string '10' → number
      advanced_application_name: 'Advanced App A',
    });
    // exactly 11 fields — no app_secret/extra leakage
    expect(Object.keys(out).sort()).toEqual(
      [
        'advanced_application',
        'advanced_application_name',
        'create_time',
        'datasource_ids',
        'datasource_names',
        'id',
        'name',
        'oid',
        'prompt',
        'specific_ds',
        'type',
      ].sort(),
    );
  });

  it('datasource_ids is [] when null; datasource_names is [] when no ids', () => {
    const out = toCustomPromptSnake(
      row({ id: 1, type: 'ANALYSIS', datasourceIds: null }),
      dsMap,
      advMap,
    );
    expect(out.datasource_ids).toEqual([]);
    expect(out.datasource_names).toEqual([]);
  });

  it('datasource_names drops unknown ids + preserves order of known ones', () => {
    const out = toCustomPromptSnake(
      row({
        id: 1,
        type: 'GENERATE_SQL',
        datasourceIds: [2, 999, 1, 888], // 999 + 888 unknown → dropped
      }),
      dsMap,
      advMap,
    );
    expect(out.datasource_ids).toEqual([2, 999, 1, 888]); // ids verbatim
    expect(out.datasource_names).toEqual(['users', 'orders']); // unknown dropped, order preserved
  });

  it('advanced_application coerces String? → number; null/empty → null', () => {
    const a = toCustomPromptSnake(
      row({ id: 1, type: 'GENERATE_SQL', advancedApplication: '11' }),
      dsMap,
      advMap,
    );
    expect(a.advanced_application).toBe(11);
    expect(a.advanced_application_name).toBe('Advanced App B');

    const b = toCustomPromptSnake(
      row({ id: 2, type: 'GENERATE_SQL', advancedApplication: null }),
      dsMap,
      advMap,
    );
    expect(b.advanced_application).toBeNull();
    expect(b.advanced_application_name).toBeNull();

    const c = toCustomPromptSnake(
      row({ id: 3, type: 'GENERATE_SQL', advancedApplication: '' }),
      dsMap,
      advMap,
    );
    expect(c.advanced_application).toBeNull();
    expect(c.advanced_application_name).toBeNull();
  });

  it('advanced_application_name null when advAppId present but not in map', () => {
    const out = toCustomPromptSnake(
      row({ id: 1, type: 'GENERATE_SQL', advancedApplication: '99999' }),
      dsMap,
      advMap,
    );
    expect(out.advanced_application).toBe(99999);
    expect(out.advanced_application_name).toBeNull();
  });

  it('create_time is epoch-ms; 0 when createTime is null', () => {
    const withTime = toCustomPromptSnake(
      row({
        id: 1,
        type: 'GENERATE_SQL',
        createTime: new Date('2026-07-26T00:00:00Z'),
      }),
      dsMap,
      advMap,
    );
    expect(withTime.create_time).toBe(Date.parse('2026-07-26T00:00:00Z'));

    const nullTime = toCustomPromptSnake(
      row({ id: 2, type: 'GENERATE_SQL', createTime: null }),
      dsMap,
      advMap,
    );
    expect(nullTime.create_time).toBe(0);
  });

  it('type + specific_ds + name + prompt pass through verbatim (null-safe)', () => {
    const out = toCustomPromptSnake(
      row({
        id: 1,
        type: 'PREDICT_DATA',
        name: null,
        prompt: null,
        specificDs: false,
      }),
      dsMap,
      advMap,
    );
    expect(out.type).toBe('PREDICT_DATA');
    expect(out.specific_ds).toBe(false);
    expect(out.name).toBeNull();
    expect(out.prompt).toBeNull();
  });
});
