// data-training snake-mapper spec — pure
// function: maps a Prisma DataTraining row (+ caller-supplied name maps) to
// the 10-field snake_case wire shape the frontend `training/index.vue`
// reads (id, oid, datasource, datasource_name, question, description, enabled,
// create_time, advanced_application, advanced_application_name). id/oid are
// NUMBER (frontend echoes them in DELETE bare-array + enable path); datasource
// is a single Int? (not an array like terminology) → datasource_name is
// string | null (not string[]); advanced_application is String? on the column
// → coerce Number(String?).
import { toDataTrainingSnake } from './data-training-snake-mapper';

interface RowInput {
  id: number;
  oid: number;
  datasource: number | null;
  question: string;
  description: string | null;
  enabled: boolean;
  advancedApplication: string | null;
  createdAt: Date;
}

function row(overrides: Partial<RowInput> = {}): RowInput {
  return {
    id: 1,
    oid: 1,
    datasource: 10,
    question: 'how many orders?',
    description: 'count orders',
    enabled: true,
    advancedApplication: '7',
    createdAt: new Date('2025-01-02T03:04:05.000Z'),
    ...overrides,
  };
}

describe('toDataTrainingSnake', () => {
  it('maps every field: id/oid NUMBER, create_time epoch-ms, names from maps', () => {
    const r = row();
    const snake = toDataTrainingSnake(
      r,
      new Map([[10, 'sales']]),
      new Map([[7, '高级助手']]),
    );
    expect(snake).toEqual({
      id: 1,
      oid: 1,
      datasource: 10,
      datasource_name: 'sales',
      question: 'how many orders?',
      description: 'count orders',
      enabled: true,
      advanced_application: 7,
      advanced_application_name: '高级助手',
      create_time: r.createdAt.getTime(),
    });
  });

  it('returns null datasource_name when datasource is null', () => {
    const r = row({ id: 1, datasource: null });
    const snake = toDataTrainingSnake(r, new Map([[10, 'sales']]), new Map());
    expect(snake.datasource).toBeNull();
    expect(snake.datasource_name).toBeNull();
  });

  it('falls back to null datasource_name when the id is not in the map', () => {
    const r = row({ id: 1, datasource: 999 });
    const snake = toDataTrainingSnake(r, new Map([[10, 'sales']]), new Map());
    expect(snake.datasource).toBe(999);
    expect(snake.datasource_name).toBeNull();
  });

  it('coerces advancedApplication string→number and resolves the name from the map', () => {
    const r = row({ id: 1, advancedApplication: '42' });
    const snake = toDataTrainingSnake(
      r,
      new Map(),
      new Map([[42, 'orders-bot']]),
    );
    expect(snake.advanced_application).toBe(42);
    expect(snake.advanced_application_name).toBe('orders-bot');
  });

  it('returns null advanced_application when the column is null or empty string', () => {
    const r1 = row({ id: 1, advancedApplication: null });
    const r2 = row({ id: 2, advancedApplication: '' });
    const emptyStr: Map<number, string> = new Map();
    expect(
      toDataTrainingSnake(r1, emptyStr, emptyStr).advanced_application,
    ).toBeNull();
    expect(
      toDataTrainingSnake(r2, emptyStr, emptyStr).advanced_application,
    ).toBeNull();
  });

  it('falls back to null advanced_application_name when the id is not in the map', () => {
    const r = row({ id: 1, advancedApplication: '99' });
    const snake = toDataTrainingSnake(r, new Map(), new Map([[7, 'x']]));
    expect(snake.advanced_application).toBe(99);
    expect(snake.advanced_application_name).toBeNull();
  });

  it('preserves enabled false + description null', () => {
    const r = row({
      id: 1,
      enabled: false,
      description: null,
      datasource: null,
      advancedApplication: null,
    });
    const snake = toDataTrainingSnake(r, new Map(), new Map());
    expect(snake.enabled).toBe(false);
    expect(snake.description).toBeNull();
    expect(snake.datasource_name).toBeNull();
    expect(snake.advanced_application).toBeNull();
    expect(snake.advanced_application_name).toBeNull();
  });
});
