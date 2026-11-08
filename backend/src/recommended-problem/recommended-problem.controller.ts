// recommended-problem.controller — recommended-question configuration per
// datasource.
//
// 3 routes (all under the bare `/recommended_problem` prefix, NOT
// `system/recommended_problem`):
//   - GET  /recommended_problem/get_datasource_recommended/:dsId
//        → bare array of {id, datasource_id, question}
//   - GET  /recommended_problem/get_datasource_recommended_base/:dsId
//        → bare object {datasource_id, recommended_config, questions}
//   - POST /recommended_problem/save_recommended_problem
//        (body RecommendedProblemSaveBody; replace-all; frontend ignores return)
//
// The 2 GET routes return 200 by default (no @HttpCode needed).
// The POST save uses @HttpCode(200) (NestJS's default 201 would break the
// contract, which expects 200).
// The global TransformInterceptor wraps bare arrays/objects in {success,code:0,msg,
// data:...}; the frontend axios interceptor unwraps `data` when `code===0`, so the
// bare-array/bare-object wire shape is preserved transparently.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import {
  RecommendedProblemService,
  type RecommendedProblemSaveBody,
} from './recommended-problem.service';

@UseGuards(JwtAuthGuard)
@Controller('recommended_problem')
export class RecommendedProblemController {
  constructor(
    private readonly recommendedProblemService: RecommendedProblemService,
  ) {}

  /** GET /recommended_problem/get_datasource_recommended/:dsId → bare array of
   *  snake-mapped rows. The frontend dialog assigns `res` directly to
   *  recommendedProblemList (no unwrap). */
  @Get('get_datasource_recommended/:dsId')
  @UseGuards(WsAdminGuard)
  listByDatasource(@Param('dsId', ParseIntPipe) dsId: number) {
    return this.recommendedProblemService.listByDatasource(dsId);
  }

  /** GET /recommended_problem/get_datasource_recommended_base/:dsId → bare
   *  object {datasource_id, recommended_config, questions}. The chat UI
   *  (RecommendQuestionQuick.vue) reads res.recommended_config + res.questions. */
  @Get('get_datasource_recommended_base/:dsId')
  getBase(@Param('dsId', ParseIntPipe) dsId: number) {
    return this.recommendedProblemService.getBase(dsId);
  }

  /** POST /recommended_problem/save_recommended_problem → replace-all: update
   *  Datasource.recommendedConfig + deleteMany + createMany. The frontend
   *  ignores the response body (re-fetches via the _base route on next chat
   *  open). Body is the snake_case RecommendedProblemSaveBody (plain interface,
   *  no DTO class → ValidationPipe passthrough). NOTE `problemInfo` is
   *  camelCase, NOT problem_info — the frontend sends camelCase. Returns
   *  {datasource_id, recommended_config, count} for the @SystemLog resources
   *  callback. */
  @Post('save_recommended_problem')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '更新数据源推荐问题配置',
    resources: (r) => {
      const c = r as { datasource_id: number };
      return [
        { name: `datasource #${c.datasource_id}`, originId: c.datasource_id },
      ];
    },
  })
  save(@Body() body: RecommendedProblemSaveBody) {
    return this.recommendedProblemService.save(body);
  }
}
