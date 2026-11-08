// recommended-problem-snake-mapper spec — verifies the snake_case wire shape
// the frontend (api/recommendedApi.ts + views/ds/RecommendedProblemConfigDialog.vue)
// reads.
//
// The frontend reads:
//   - get_recommended_problem(dsId) → bare array of rows, each {id, datasource_id, question}
//     (frontend RecommendedProblem interface also declares `sort` but never reads it
//     meaningfully — save ignores client sort; the model lacks the
//     column entirely, so the mapper emits only the 3 fields it has — frontend tolerates)
//   - get_datasource_recommended_base(dsId) → bare object {datasource_id, recommended_config,
//     questions} (questions = JSON-stringified string[] when config===2, null otherwise —
//     built in the service, NOT this mapper; the mapper only handles list rows)
import {
  toRecommendedProblemSnake,
  type DsRecommendedProblemRow,
} from './recommended-problem-snake-mapper';

function row(
  partial: Partial<DsRecommendedProblemRow> & {
    id: number;
    datasourceId: number;
  },
): DsRecommendedProblemRow {
  return {
    question: 'What is the revenue?',
    createdAt: new Date('2026-07-26T00:00:00Z'),
    ...partial,
  };
}

describe('toRecommendedProblemSnake', () => {
  it('emits 3 snake fields with correct values + types', () => {
    const out = toRecommendedProblemSnake(
      row({ id: 5, datasourceId: 10, question: 'Show me sales by region' }),
    );
    expect(out).toEqual({
      id: 5,
      datasource_id: 10,
      question: 'Show me sales by region',
    });
    expect(Object.keys(out).sort()).toEqual(
      ['datasource_id', 'id', 'question'].sort(),
    );
  });

  it('question passes through verbatim (no coercion)', () => {
    const out = toRecommendedProblemSnake(
      row({
        id: 1,
        datasourceId: 2,
        question: '中文问题 with "quotes" + {{table}}',
      }),
    );
    expect(out.question).toBe('中文问题 with "quotes" + {{table}}');
  });

  it('id + datasource_id are numbers (frontend may send id back on save but backend ignores)', () => {
    const out = toRecommendedProblemSnake(
      row({ id: 999, datasourceId: 42, question: 'q' }),
    );
    expect(typeof out.id).toBe('number');
    expect(typeof out.datasource_id).toBe('number');
  });
});
