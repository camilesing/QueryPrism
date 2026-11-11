// chart-object.builder — translates the LLM's field-mapping chart config
// (ChartGenResult = {chartType, config:{xField,yField,seriesField?}}) into
// the chart-object shape the Vue frontend parses from `record.chart`
// (frontend/src/views/chat/chat-block/ChartBlock.vue):
//
//   table:       {type, title, columns:[{name,value}]}
//   column/bar:
//   line:        {type, title, axis:{x:{name,value}, y:[{name,value}], series?}}
//   pie:         {type, title, axis:{y:[{name,value}], series:{name,value}}}
//
// The frontend renders `axis.*.value` directly against the row keys
// (DisplayChartBlock -> ChartComponent), so the field names must stay exactly
// as the SQL result reports them. Chart types mirror the prompt template
// (template.yaml): bar | column | line | pie | table. Anything unusable falls
// back to a table view of the result columns, which the frontend always knows
// how to draw.
//
// Pure function, no Nest deps (same contract as chart-spec.builder).

/** Bar/column/line share the same x/y axis mapping (bar is just transposed
 *  at render time in the frontend). */
const AXIS_CHART_TYPES = new Set(['bar', 'column', 'line']);

function asField(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function axisColumn(field: string): { name: string; value: string } {
  return { name: field, value: field };
}

/**
 * Build the chart object for the given LLM chart config.
 *
 * `columns` is the SQL result's column list — used for the table fallback and
 * for table charts. `record.chart` is rendered as-is by the frontend, so this
 * must never return null: an unusable config degrades to a table.
 */
export function buildQueryPrismChartObject(
  chartType: string,
  config: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const type = chartType.trim().toLowerCase();
  const title = asField(config.title) ?? '';
  const xField = asField(config.xField);
  const yField = asField(config.yField);
  const seriesField = asField(config.seriesField);

  const asTable = (): Record<string, unknown> => ({
    type: 'table',
    title,
    columns: columns.map(axisColumn),
  });

  if (AXIS_CHART_TYPES.has(type)) {
    if (!xField || !yField) return asTable();
    const axis: Record<string, unknown> = {
      x: axisColumn(xField),
      y: [axisColumn(yField)],
    };
    if (seriesField) axis.series = axisColumn(seriesField);
    return { type, title, axis };
  }

  if (type === 'pie') {
    // The LLM prompt puts the category in xField; an explicit seriesField wins.
    const category = seriesField ?? xField;
    if (!yField || !category) return asTable();
    return {
      type: 'pie',
      title,
      axis: {
        y: [axisColumn(yField)],
        series: axisColumn(category),
      },
    };
  }

  return asTable();
}

/**
 * Inverse of `buildQueryPrismChartObject` for the array-of-points G2 spec builder
 * (chart-spec.builder): recover the `{xField,yField,seriesField}` mapping from
 * a chart object. Used by the MCP ask_question image path, which reads
 * the persisted chart event and needs the field mapping, not axis names.
 */
export function chartObjectToFieldMapping(
  chart: Record<string, unknown>,
): Record<string, string | undefined> {
  const axis =
    chart.axis != null && typeof chart.axis === 'object'
      ? (chart.axis as Record<string, unknown>)
      : undefined;
  const x = axis?.x as { value?: unknown } | undefined;
  const yAxis = axis?.y;
  const y = (Array.isArray(yAxis) ? (yAxis as unknown[])[0] : yAxis) as
    { value?: unknown } | undefined;
  const series = axis?.series as { value?: unknown } | undefined;

  return {
    // Pie charts store the category in series; the spec builder's pie case
    // uses xField as the color channel.
    xField: asField(x?.value) ?? asField(series?.value),
    yField: asField(y?.value),
    seriesField: asField(series?.value),
  };
}
