// assistant-snake-mapper — pure functions that map a Prisma Assistant row to
// the snake_case wire shapes the frontend (api/embedded.ts +
// views/system/embedded/iframe.vue) reads. Applied in the controller
// (protects the service spec). Reverse-engineered from the frontend source
// of truth, not backend DTO.
//
// Two response shapes:
// 1. toAssistantSnake → list/create/update/delete responses. Frontend
//    iframe.vue reads id, name, type, description, configuration (JSON
//    STRING — view does JSON.parse), domain, enable_custom_model,
//    custom_model. We also emit app_id (public identifier),
//    status + create_time/update_time (harmless metadata). app_secret is
//    NEVER emitted (security — AES-encrypted at rest; plaintext only
//    returned by the type-4 embedded create/rotate, cycle 3).
// 2. toAdvancedApplicationSnake → GET /advanced_application list. Frontend
//    el-option picker (professional/training/prompt) reads {id, name} only.
//
// configuration is serialized to a JSON STRING (frontend
// JSON.parse's it — mirrors the dashboard canvas-field pattern); domain
// emitted as the raw delimited string (frontend splits on /[,;]/); custom_model
// passed through verbatim (Json column → number/string/object/null); picture
// column is vestigial (the frontend reads logo from configuration.logo, which
// PATCH /ui maintains) so it is omitted.
import type { Assistant } from '@prisma/client';

/** Wire shape for the assistant-app list + create/update responses. */
export interface AssistantSnake {
  id: number;
  name: string;
  type: number;
  description: string | null;
  /** JSON-encoded STRING — frontend does `JSON.parse(row.configuration)`. */
  configuration: string;
  domain: string | null;
  app_id: string;
  enable_custom_model: boolean;
  /** Verbatim pass-through of the Json column (number/string/object/null). */
  custom_model: unknown;
  status: string;
  create_time: number;
  update_time: number;
}

/** Minimal picker shape for GET /advanced_application ({id, name} only). */
export interface AdvancedApplicationSnake {
  id: number;
  name: string;
}

/**
 * Map an Assistant row to the snake_case wire shape for the admin list +
 * create/update responses. `configuration` is serialized to a JSON string
 * (the frontend JSON.parse's it); null configuration becomes `"{}"` so the
 * frontend parse never throws. `app_secret` is intentionally absent.
 */
export function toAssistantSnake(row: Assistant): AssistantSnake {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    configuration: JSON.stringify(row.configuration ?? {}),
    domain: row.domain,
    app_id: row.appId,
    enable_custom_model: row.enableCustomModel,
    custom_model: row.customModel ?? null,
    status: row.status,
    create_time: row.createdAt.getTime(),
    update_time: row.updatedAt.getTime(),
  };
}

/**
 * Map an Assistant row to the minimal {id, name} picker shape for
 * GET /advanced_application (consumed by professional/training/prompt
 * admin pages' el-option pickers).
 */
export function toAdvancedApplicationSnake(
  row: Assistant,
): AdvancedApplicationSnake {
  return { id: row.id, name: row.name };
}
