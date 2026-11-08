// dashboard-snake-mapper — pure functions that map Prisma CoreDashboard rows
// to the snake_case wire shapes the frontend (api/dashboard.ts +
// canvasUtils.ts + ResourceTree.vue + treeNode.ts) reads.
//
// Applied in the controller (not the service) to protect the existing
// dashboard.service.spec. Json blob fields
// (canvasStyleData/componentData/canvasViewInfo/mobileLayout) are stored as
// Prisma Json objects and transformed to JSON STRINGS on read
// (string↔object conversion).
//
// Three response shapes are emitted:
// 1. toDashboardNodeSnake → DashboardBaseResponse for list_resource tree
//    {id, name, pid, node_type, leaf, type, create_time, update_time, children}
// 2. toDashboardResourceSnake → full row for load_resource (canvas fields as
//    JSON strings + create_name/update_name via User join)
// 3. toDashboardResourceSnake (without opts) → BaseDashboard subset for
//    create_resource/create_canvas/update_resource/update_canvas responses
//    (frontend only reads res.id; extra fields are harmless)
//
// Design notes:
// - id is a NUMBER (autoincrement integer; no UUID/snowflake ids)
// - pid is number|null — the frontend's SQTreeNode.pid accepts
//   string|number; tree is pre-built by backend so pid is metadata
// - leaf = (node_type === 'leaf') is computed here (there is no leaf DB
//   column) so treeDraggableChart.ts:83 works
// - status runtime-coerced 'active'→1 / else→0 (QueryPrism
//   keeps String @default("active") — no migration, coerce on read)
// - canvas fields emitted as JSON strings with safe defaults ('[]'/'{}' when
//   null) so frontend JSON.parse never throws
// - org_id always null (QueryPrism has no orgId column; the frontend
//   doesn't read it)
import type { CoreDashboard } from '@prisma/client';
import type { DashboardNode } from './dashboard.service';

/** Tree node shape for list_resource (DashboardBaseResponse). */
export interface DashboardNodeSnake {
  id: number;
  name: string;
  pid: number | null;
  node_type: string;
  leaf: boolean;
  type: string | null;
  create_time: number;
  update_time: number;
  children: DashboardNodeSnake[];
}

/** Full row shape for load_resource + create/update responses (BaseDashboard superset). */
export interface DashboardResourceSnake {
  id: number;
  name: string;
  pid: number | null;
  workspace_id: number;
  org_id: string | null;
  level: number;
  node_type: string;
  type: string | null;
  canvas_style_data: string;
  component_data: string;
  canvas_view_info: string;
  mobile_layout: unknown;
  status: number;
  version: number;
  content_id: number | null;
  create_time: number;
  update_time: number;
  create_by: number | null;
  update_by: number | null;
  create_name: string | null;
  update_name: string | null;
}

/**
 * Map a DashboardNode (with children) to the snake_case tree shape for the
 * list_resource response. `leaf` is derived from node_type.
 */
export function toDashboardNodeSnake(node: DashboardNode): DashboardNodeSnake {
  return {
    id: node.id,
    name: node.name,
    pid: node.pid,
    node_type: node.nodeType,
    leaf: node.nodeType === 'leaf',
    type: node.type,
    create_time: node.createdAt.getTime(),
    update_time: node.updatedAt.getTime(),
    children: node.children.map(toDashboardNodeSnake),
  };
}

/**
 * Map a CoreDashboard row to the snake_case resource shape for load_resource
 * (with create_name/update_name via User join) and create/update responses
 * (without opts — frontend only reads res.id).
 *
 * Canvas fields (canvas_style_data/component_data/canvas_view_info) are emitted
 * as JSON STRINGS because the frontend does `JSON.parse(canvasInfo.*)`. Null
 * canvas fields get safe defaults ('{}'/'[]') so JSON.parse never throws.
 */
export function toDashboardResourceSnake(
  row: CoreDashboard,
  opts?: { createName?: string | null; updateName?: string | null },
): DashboardResourceSnake {
  return {
    id: row.id,
    name: row.name,
    pid: row.pid,
    workspace_id: row.oid,
    org_id: null, // QueryPrism has no orgId column (§107 deviation)
    level: row.level,
    node_type: row.nodeType,
    type: row.type,
    canvas_style_data: JSON.stringify(row.canvasStyleData ?? {}),
    component_data: JSON.stringify(row.componentData ?? []),
    canvas_view_info: JSON.stringify(row.canvasViewInfo ?? {}),
    mobile_layout: row.mobileLayout,
    status: row.status === 'active' ? 1 : 0,
    version: row.version,
    content_id: row.contentId,
    create_time: row.createdAt.getTime(),
    update_time: row.updatedAt.getTime(),
    create_by: row.createBy,
    update_by: row.updateBy,
    create_name: opts?.createName ?? null,
    update_name: opts?.updateName ?? null,
  };
}
