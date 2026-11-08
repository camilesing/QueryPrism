// embedded-snake-mapper — pure function that maps a Prisma Assistant row
// (type==4) to the snake_case wire shape the frontend
// (api/embedded.ts embeddedApi + views/system/embedded/Page.vue R8) reads.
// Applied in the controller (protects service spec).
//
// The list response (GET /system/embedded/:pageNum/:pageSize) returns
// `{items: [EmbeddedSnake], total: number}` (pager shape). Page.vue
// reads `res.items` + `res.total` and, per row: id, name, app_id, app_secret
// (PLAINTEXT — the service decrypts the AES-at-rest secret and passes it via
// opts.appSecretPlain), domain (raw delimited string), type, configuration
// (JSON STRING — frontend JSON.parse it), description.
//
// app_secret is emitted as PLAINTEXT (decrypt-on-read — QueryPrism stores
// the secret AES-encrypted at rest and decrypts for the list display +
// the copy button); create/update responses omit app_secret (frontend
// re-fetches the list to see it). configuration is serialized as a JSON
// STRING. domain stays the raw delimited string (frontend splits /[,;]/).
import type { Assistant } from '@prisma/client';

/** Wire shape for each item in the GET /system/embedded list response. */
export interface EmbeddedSnake {
  id: number;
  name: string;
  app_id: string;
  /** Plaintext app_secret (decrypted by the service, passed via opts).
   *  Null on create/update responses — the frontend re-fetches the list. */
  app_secret: string | null;
  domain: string | null;
  type: number;
  /** JSON-encoded STRING — frontend does `JSON.parse`. */
  configuration: string;
  description: string | null;
  status: string;
  create_time: number;
  update_time: number;
}

/**
 * Map an Assistant row (type==4) to the snake_case wire shape for the
 * embedded-management list + create/update responses. `app_secret` is the
 * plaintext secret decrypted by the service (via opts.appSecretPlain); null
 * when omitted (create/update — frontend re-fetches the list to see it).
 * `configuration` is serialized to a JSON string (frontend JSON.parse it);
 * null configuration becomes `"{}"`.
 */
export function toEmbeddedSnake(
  row: Assistant,
  opts?: { appSecretPlain?: string | null },
): EmbeddedSnake {
  return {
    id: row.id,
    name: row.name,
    app_id: row.appId,
    app_secret: opts?.appSecretPlain ?? null,
    domain: row.domain,
    type: row.type,
    configuration: JSON.stringify(row.configuration ?? {}),
    description: row.description,
    status: row.status,
    create_time: row.createdAt.getTime(),
    update_time: row.updatedAt.getTime(),
  };
}
