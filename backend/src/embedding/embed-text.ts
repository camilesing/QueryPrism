// Single vector-input composition shared by the synchronous write paths
// (embedDatasource / embedTable) and the null-embedding backfill — the
// embedded text can never drift between the path that writes on edit and the
// path that fills later.

/** `word\n描述`-style row text: primary alone when there is no secondary. */
export function embedRowText(
  primary: string,
  secondary?: string | null,
): string {
  return secondary ? `${primary}\n${secondary}` : primary;
}
