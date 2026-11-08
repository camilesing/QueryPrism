// recommended-problem.service — recommended-question configuration per
// datasource.
//
// 3 routes (all under /recommended_problem prefix):
//   - GET  /get_datasource_recommended/:dsId       → bare array of {id, datasource_id, question}
//   - GET  /get_datasource_recommended_base/:dsId  → bare object {datasource_id, recommended_config, questions}
//   - POST /save_recommended_problem               → body; replace-all semantics
//
// save = replace-all: DELETE all rows for the
// datasource_id, then INSERT each problemInfo item (id ignored, regenerated via
// autoincrement; client sort ignored — QueryPrism's model has no sort column).
// Also updates Datasource.recommendedConfig to body.recommended_config (1=AI auto,
// 2=user-defined).
//
// `questions` on the _base response is a JSON-stringified string[] (or null when
// recommended_config !== 2). The frontend `RecommendQuestionQuick.vue` reads
// `res.recommended_config` + `res.questions` — when config===2 uses questions
// directly, else falls back to the cached chat recommended_question or the live
// LLM SSE stream (ChatService.runRecommendQuestions).
//
// The chat pipeline does NOT call these HTTP routes — it reads the
// DsRecommendedProblem table directly via Prisma (chat.service.ts
// getRecommendQuestions). This module is admin-UI-only at the HTTP layer.
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import {
  toRecommendedProblemSnake,
  type RecommendedProblemSnake,
} from './recommended-problem-snake-mapper';
import { tr } from '../common/i18n/translate';

/** One item in the save body's `problemInfo` array. The frontend's
 *  RecommendedProblem interface declares `id?`, `question`, `datasource_id?`,
 *  `sort`. On save, `id` + `sort` + `datasource_id` are IGNORED (QueryPrism
 *  has no sort/remark/createBy columns — only datasourceId + question are
 *  persisted). */
export interface RecommendedProblemSaveItem {
  id?: number; // ignored on save (regenerated)
  question: string;
  datasource_id?: number; // ignored (uses body.datasource_id)
  sort?: number; // ignored (no sort column)
}

/** The save body shape the frontend sends. NOTE `problemInfo` is camelCase,
 *  NOT `problem_info` — the frontend sends camelCase. */
export interface RecommendedProblemSaveBody {
  recommended_config: number; // 1 = AI auto, 2 = user-defined
  datasource_id: number;
  problemInfo: RecommendedProblemSaveItem[];
}

/** The _base route response shape (bare object — frontend reads
 *  res.recommended_config + res.questions). */
export interface RecommendedProblemBaseResponse {
  datasource_id: number;
  recommended_config: number;
  questions: string | null; // JSON-stringified string[] when config===2, else null
}

/** The save route response shape (frontend ignores the return; this is for the
 *  @SystemLog resources callback §94). */
export interface RecommendedProblemSaveResponse {
  datasource_id: number;
  recommended_config: number;
  count: number;
}

@Injectable()
export class RecommendedProblemService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /recommended_problem/get_datasource_recommended/:dsId → bare array of
   *  snake-mapped rows for the datasource. */
  async listByDatasource(dsId: number): Promise<RecommendedProblemSnake[]> {
    if (!(await this.isOwned(dsId))) return [];
    const rows = await this.prisma.dsRecommendedProblem.findMany({
      where: { datasourceId: dsId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => toRecommendedProblemSnake(r));
  }

  /** GET /recommended_problem/get_datasource_recommended_base/:dsId → bare
   *  object {datasource_id, recommended_config, questions}: returns
   *  {ds_id, 0, None} if datasource missing, {ds_id, 1, None} if config==1,
   *  else {ds_id, config, JSON.stringify(questions)}. */
  async getBase(dsId: number): Promise<RecommendedProblemBaseResponse> {
    // Foreign and missing datasource ids look identical (config 0), so this
    // endpoint cannot be used to probe another workspace's datasources.
    const ds = await this.prisma.datasource.findFirst({
      where: { id: dsId, oid: this.currentOid() },
    });
    if (!ds) {
      return { datasource_id: dsId, recommended_config: 0, questions: null };
    }
    // Datasource.recommendedConfig is Json? — coerce.
    const config = toConfigNumber(ds.recommendedConfig);
    if (config !== 2) {
      return {
        datasource_id: dsId,
        recommended_config: config,
        questions: null,
      };
    }
    const rows = await this.prisma.dsRecommendedProblem.findMany({
      where: { datasourceId: dsId },
      orderBy: { createdAt: 'asc' },
      select: { question: true },
    });
    const questions = JSON.stringify(rows.map((r) => r.question));
    return { datasource_id: dsId, recommended_config: config, questions };
  }

  /** POST /recommended_problem/save_recommended_problem → replace-all: update
   *  Datasource.recommendedConfig + deleteMany + createMany (DELETE all rows,
   *  then INSERT each problemInfo item; client id/sort ignored — no sort
   *  column, id regenerated via autoincrement). Returns {datasource_id,
   *  recommended_config, count} for the @SystemLog resources callback
   *  (post-await, pre-envelope). */
  async save(
    body: RecommendedProblemSaveBody,
  ): Promise<RecommendedProblemSaveResponse> {
    // Datasource.recommendedConfig is Json? — a number value is
    // accepted by Prisma's Json input.
    const data = (body.problemInfo ?? []).map((it) => ({
      datasourceId: body.datasource_id,
      question: it.question,
    }));
    // The ownership check + config update + replace-all rows run in ONE
    // transaction: a mid-sequence failure must not leave the config changed
    // with the questions deleted.
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.datasource.findFirst({
        where: { id: body.datasource_id, oid: this.currentOid() },
        select: { id: true },
      });
      if (!owned) {
        throw new NotFoundException(
          tr('datasource.not_found', { id: body.datasource_id }),
        );
      }
      await tx.datasource.update({
        where: { id: body.datasource_id },
        data: { recommendedConfig: body.recommended_config },
      });
      await tx.dsRecommendedProblem.deleteMany({
        where: { datasourceId: body.datasource_id },
      });
      if (data.length > 0) {
        await tx.dsRecommendedProblem.createMany({ data });
      }
    });
    return {
      datasource_id: body.datasource_id,
      recommended_config: body.recommended_config,
      count: data.length,
    };
  }

  /** Workspace id resolved from the request context by JwtAuthGuard. */
  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private async isOwned(dsId: number): Promise<boolean> {
    const ds = await this.prisma.datasource.findFirst({
      where: { id: dsId, oid: this.currentOid() },
      select: { id: true },
    });
    return ds != null;
  }
}

/** Coerce the Datasource.recommendedConfig Json value to a number (1 or 2).
 *  null/missing/non-numeric → 0 (treats as "not configured"). The column is
 *  Json? — the value is usually a number, but defensive coercion handles
 *  null/edge cases. */
function toConfigNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
