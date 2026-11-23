// Single vector-input composition shared by the synchronous write paths
// (embedDatasource / embedTable / metric definitions) and the null-embedding
// backfill — the embedded text can never drift between the path that writes
// on edit and the path that fills later.

/** `word\n描述`-style row text: primary alone when there is no secondary. */
export function embedRowText(
  primary: string,
  secondary?: string | null,
): string {
  return secondary ? `${primary}\n${secondary}` : primary;
}

/** Vector input of one metric definition: the natural-language match surface
 *  (name + aliases) then the description. The code and the kind-specific
 *  definition JSON stay out — they are identifiers / calibers, not language.
 *  Shared by the write hook, the import path and the backfill so the text can
 *  never drift between the paths that embed eagerly and the one that fills
 *  later (same rule as embedRowText). */
export function metricDefEmbedText(row: {
  name: string;
  aliases?: unknown;
  description?: string | null;
}): string {
  const aliases = Array.isArray(row.aliases)
    ? row.aliases
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  return embedRowText([row.name.trim(), ...aliases].join(' '), row.description);
}
