// chart-spec.builder — translates the LLM's field-mapping chart config
// (ChartGenResult = {chartType, config:{xField,yField,seriesField?}}) plus the
// SQL result rows/columns into a G2 5.x grammar-of-graphics spec that g2-ssr
// renders to PNG. Pure function, no Nest deps — Phase 9's frontend chart
// rendering reuses the exact same spec (decision §46).
//
// Chart-type vocabulary mirrors the prompt template (template.yaml:75):
//   bar | column | line | pie | table
// `table` and any unknown type return null (no image — the MCP tool then
// returns the data as text only).

/** A free-form G2 5.x spec (the grammar is large; we only build the subset
 *  g2-ssr needs: type + data + encode + coordinate + transform). */
export type G2Spec = Record<string, unknown>;

/** Coerce a config field to a string column name, or undefined. */
function asField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Map the row arrays into objects keyed by column name so G2's encode can
 *  reference fields by name. Object.fromEntries keeps undefined values; jest's
 *  toEqual treats undefined props as absent, and G2 reads missing fields as
 *  null which is fine for sparse rows. */
function toObjects(
  rows: readonly unknown[][],
  columns: readonly string[],
): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/**
 * Build a G2 5.x spec for the given chart type, or null when no image should
 * be rendered (table / unknown type / missing required fields).
 *
 * Encoding rules:
 *  - column: category→x, value→y, seriesField→color
 *  - bar:    horizontal — swap so value→x, category→y, seriesField→color
 *  - line:   category→x, value→y, seriesField→color
 *  - pie:    value→y, category→color, theta coordinate + stack transform
 */
export function buildG2Spec(
  chartType: string,
  config: Record<string, unknown>,
  rows: unknown[][],
  columns: string[],
): G2Spec | null {
  const data = toObjects(rows, columns);
  const xField = asField(config.xField);
  const yField = asField(config.yField);
  const seriesField = asField(config.seriesField);

  const withColor = (
    encode: Record<string, string>,
  ): Record<string, string> => {
    if (seriesField) encode.color = seriesField;
    return encode;
  };

  switch (chartType) {
    case 'column':
      if (!xField || !yField) return null;
      return {
        type: 'interval',
        data,
        encode: withColor({ x: xField, y: yField }),
      };
    case 'bar':
      if (!xField || !yField) return null;
      return {
        type: 'interval',
        data,
        encode: withColor({ x: yField, y: xField }),
      };
    case 'line':
      if (!xField || !yField) return null;
      return {
        type: 'line',
        data,
        encode: withColor({ x: xField, y: yField }),
      };
    case 'pie': {
      if (!yField) return null;
      const encode: Record<string, string> = { y: yField };
      if (xField) encode.color = xField;
      return {
        type: 'interval',
        data,
        encode,
        coordinate: { type: 'theta' },
        transform: [{ type: 'stack' }],
      };
    }
    default:
      // 'table' + any unknown type → no image.
      return null;
  }
}
