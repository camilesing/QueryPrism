// Canonicalises a Datasource.type value for backend branching. The frontend
// submits the DB type identifiers (`views/ds/js/ds-type.ts`), so PostgreSQL
// arrives as `pg` — not `postgresql`. Every consumer that keys off the type
// (connector factory, prompt engine mapping) must normalise through here;
// otherwise a datasource works in the connector layer but is rejected as an
// "unsupported type" by the NL2SQL pipeline. The stored value stays `pg`
// (the frontend renders icons from it) — normalise on read only.
const TYPE_ALIASES: Record<string, string> = {
  pg: 'postgresql',
  postgres: 'postgresql',
};

/** Lower-case + resolve aliases. Empty/undefined → ''. */
export function normalizeDatasourceType(
  type: string | null | undefined,
): string {
  const normalized = (type ?? '').trim().toLowerCase();
  return TYPE_ALIASES[normalized] ?? normalized;
}
