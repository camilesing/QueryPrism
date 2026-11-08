// recommended-problem-snake-mapper — maps a DsRecommendedProblem prisma row
// to the snake_case shape the frontend (api/recommendedApi.ts + views/ds/
// RecommendedProblemConfigDialog.vue) reads. Applied in the controller layer;
// the mapper is a pure function.
//
// The frontend reads 3 fields per row (the RecommendedProblem interface in
// RecommendedProblemConfigDialog.vue:11-16 also declares `sort` + optional
// `datasource_id`/`id`, but the list read only uses `question` for display +
// resubmit; save ignores client sort + id. The Prisma model lacks
// `sort`/`remark`/`create_by` columns entirely, so the mapper emits only the
// 3 fields it has — the frontend tolerates the absence of `sort` (it's in
// the interface but never validated/read critically).
//
// The `_base` route response ({datasource_id, recommended_config, questions}) is
// a composite built in the service (fetches Datasource.recommendedConfig +
// DsRecommendedProblem rows, JSON.stringify's the question array) — NOT this
// mapper (which only handles individual list rows).

/** Subset of the DsRecommendedProblem prisma row the mapper reads. Structural type. */
export interface DsRecommendedProblemRow {
  id: number;
  datasourceId: number;
  question: string;
  createdAt: Date;
}

/** The snake_case list-row shape the frontend reads (3 fields). */
export interface RecommendedProblemSnake {
  id: number;
  datasource_id: number;
  question: string;
}

/** Map a DsRecommendedProblem row to the snake_case list shape.
 *  `datasourceId` (camelCase Prisma column) → `datasource_id` (snake_case wire). */
export function toRecommendedProblemSnake(
  row: DsRecommendedProblemRow,
): RecommendedProblemSnake {
  return {
    id: row.id,
    datasource_id: row.datasourceId,
    question: row.question,
  };
}
