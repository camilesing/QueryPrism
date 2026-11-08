// DashboardController — action-style routes.
//
// POST action verbs with a snake_case wire shape. Bare
// `@Controller('dashboard')` prefix (the frontend `api/dashboard.ts` uses the
// bare name). Class-level `@UseGuards(JwtAuthGuard)`. Plain typed body
// interfaces (ValidationPipe passthrough, no DTO class). POST routes use
// `@HttpCode(200)` (NestJS's default for @Post is 201; this wire contract
// returns 200). snake-mapper applied in controller (protects service specs).
//
// 9 routes (reverse-engineered from frontend api/dashboard.ts + canvasUtils.ts +
// ResourceTree.vue + ResourceGroupOpt.vue + AddViewDashboard.vue +
// treeDraggableChart.ts):
//  1. POST /list_resource            body {node_type?}      → tree of DashboardNodeSnake
//  2. POST /load_resource            body {id}              → DashboardResourceSnake (403 if not owned)
//  3. POST /create_resource          body DashboardMutate   → DashboardResourceSnake (folder)
//  4. POST /update_resource          body {id, name, ...}    → DashboardResourceSnake (rename)
//  5. POST /create_canvas            body DashboardMutate   → DashboardResourceSnake (leaf + canvas)
//  6. POST /update_canvas            body {id, name, ...}    → DashboardResourceSnake (name + canvas)
//  7. POST /check_name               body {name, opt, id?}  → boolean (truthy=available)
//  8. DELETE /delete_resource/:id/:name                  → {success:true} (403 if not owned)
//  9. DELETE /move_resource/:id      body {pid, ...}       → {success:true}
//
// @SystemLog on mutations (CREATE for create_resource/create_canvas, UPDATE for
// update_resource/update_canvas, DELETE for delete_resource/move_resource).
// resources callback extracts name+id from raw handler return.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import { DashboardService } from './dashboard.service';
import {
  toDashboardNodeSnake,
  toDashboardResourceSnake,
} from './dashboard-snake-mapper';
import type {
  DashboardCheckNameBody,
  DashboardMoveBody,
  DashboardMutateBody,
} from './dashboard.service';
import { parseStrictInt } from '../common/utils/parse-int';
import { tr } from '../common/i18n/translate';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** P2-1: strict id parse — a bare Number() turned 'abc' into NaN, which
   *  Prisma rejects with an opaque validation 500 instead of a clean 400. */
  private parseId(raw: unknown): number {
    const id = parseStrictInt(raw);
    if (id === null) {
      throw new BadRequestException(tr('common.id_must_be_int'));
    }
    return id;
  }

  // --- list / load (read) -----------------------------------------------

  @Post('list_resource')
  @HttpCode(200)
  async listResource(@Body() body: { node_type?: string }) {
    const tree = await this.dashboardService.listResource(body.node_type);
    return tree.map(toDashboardNodeSnake);
  }

  @Post('load_resource')
  @HttpCode(200)
  async loadResource(@Body() body: { id: string | number }) {
    const row = await this.dashboardService.loadResource(this.parseId(body.id));
    return toDashboardResourceSnake(row, {
      createName: row.createName,
      updateName: row.updateName,
    });
  }

  // --- create (folder / leaf+canvas) -----------------------------------

  @Post('create_resource')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.CREATE,
    detail: '新建资源',
    resources: (r) => {
      const d = r as { id: number; name: string };
      return [{ name: d.name, originId: d.id }];
    },
  })
  async createResource(@Body() body: DashboardMutateBody) {
    const row = await this.dashboardService.createResource(body);
    return toDashboardResourceSnake(row);
  }

  @Post('create_canvas')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.CREATE,
    detail: '新建画布',
    resources: (r) => {
      const d = r as { id: number; name: string };
      return [{ name: d.name, originId: d.id }];
    },
  })
  async createCanvas(@Body() body: DashboardMutateBody) {
    const row = await this.dashboardService.createCanvas(body);
    return toDashboardResourceSnake(row);
  }

  // --- update (rename / name+canvas) ------------------------------------

  @Post('update_resource')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.UPDATE,
    detail: '更新资源',
    resources: (r) => {
      const d = r as { id: number; name: string };
      return [{ name: d.name, originId: d.id }];
    },
  })
  async updateResource(@Body() body: DashboardMutateBody) {
    const row = await this.dashboardService.updateResource(
      this.parseId(body.id),
      body,
    );
    return toDashboardResourceSnake(row);
  }

  @Post('update_canvas')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.UPDATE,
    detail: '更新画布',
    resources: (r) => {
      const d = r as { id: number; name: string };
      return [{ name: d.name, originId: d.id }];
    },
  })
  async updateCanvas(@Body() body: DashboardMutateBody) {
    const row = await this.dashboardService.updateCanvas(
      this.parseId(body.id),
      body,
    );
    return toDashboardResourceSnake(row);
  }

  // --- check_name (validate) --------------------------------------------

  @Post('check_name')
  @HttpCode(200)
  async checkName(@Body() body: DashboardCheckNameBody) {
    // Returns boolean (truthy=available, falsy=dup) — frontend uses `if (resCheck)`.
    return this.dashboardService.validateName(body);
  }

  // --- delete / move (mutations) ----------------------------------------

  @Delete('delete_resource/:id/:name')
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.DELETE,
    detail: '删除资源',
  })
  async deleteResource(@Param('id') id: string) {
    return this.dashboardService.remove(this.parseId(id));
  }

  @Delete('move_resource/:id')
  @SystemLog({
    module: OperationModule.DASHBOARD,
    type: OperationType.UPDATE,
    detail: '移动资源',
  })
  async moveResource(@Param('id') id: string, @Body() body: DashboardMoveBody) {
    // Normalize pid ('root'/'0' → null) inline (service.moveResource takes
    // already-normalized number|null — keeps signature clean for spec).
    const pid = body.pid;
    const normalizedPid =
      pid == null || pid === '' || pid === 'root' || pid === '0'
        ? null
        : this.parseId(pid);
    return this.dashboardService.moveResource(this.parseId(id), normalizedPid);
  }
}
