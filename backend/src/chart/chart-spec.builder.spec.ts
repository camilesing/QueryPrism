// chart-spec.builder spec — verifies the translation from the LLM's
// field-mapping config ({chartType, {xField,yField,seriesField?}}) + the SQL
// result rows/columns into a G2 5.x grammar-of-graphics spec that g2-ssr
// renders. Pure-function assertions (decision §7): exact literal specs, no
// mock.calls. `table` + unknown types return null (no image — decision §46).
import { buildG2Spec } from './chart-spec.builder';

const columns = ['category', 'value', 'series'];
const rows: unknown[][] = [
  ['a', 10, 'x'],
  ['b', 20, 'x'],
];
const data = [
  { category: 'a', value: 10, series: 'x' },
  { category: 'b', value: 20, series: 'x' },
];

describe('buildG2Spec', () => {
  it('builds an interval mark for column (no seriesField → no color channel)', () => {
    expect(
      buildG2Spec(
        'column',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data,
      encode: { x: 'category', y: 'value' },
    });
  });

  it('adds a color channel when seriesField is present (column)', () => {
    expect(
      buildG2Spec(
        'column',
        { xField: 'category', yField: 'value', seriesField: 'series' },
        rows,
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data,
      encode: { x: 'category', y: 'value', color: 'series' },
    });
  });

  it('swaps x/y encode for bar (horizontal) so the category lands on the y-axis', () => {
    expect(
      buildG2Spec(
        'bar',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data,
      encode: { x: 'value', y: 'category' },
    });
  });

  it('keeps seriesField as color on bar (swap does not drop it)', () => {
    expect(
      buildG2Spec(
        'bar',
        { xField: 'category', yField: 'value', seriesField: 'series' },
        rows,
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data,
      encode: { x: 'value', y: 'category', color: 'series' },
    });
  });

  it('builds a line mark', () => {
    expect(
      buildG2Spec(
        'line',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toEqual({ type: 'line', data, encode: { x: 'category', y: 'value' } });
  });

  it('builds a pie: theta coordinate + stack, yField→y, xField→color', () => {
    expect(
      buildG2Spec(
        'pie',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data,
      encode: { y: 'value', color: 'category' },
      coordinate: { type: 'theta' },
      transform: [{ type: 'stack' }],
    });
  });

  it('returns null for table (no image rendered)', () => {
    expect(
      buildG2Spec(
        'table',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toBeNull();
  });

  it('returns null for an unknown chartType', () => {
    expect(
      buildG2Spec(
        'radar',
        { xField: 'category', yField: 'value' },
        rows,
        columns,
      ),
    ).toBeNull();
  });

  it('returns null when column/bar/line are missing xField or yField', () => {
    expect(
      buildG2Spec('column', { yField: 'value' }, rows, columns),
    ).toBeNull();
    expect(
      buildG2Spec('bar', { xField: 'category' }, rows, columns),
    ).toBeNull();
    expect(buildG2Spec('line', {}, rows, columns)).toBeNull();
  });

  it('returns null when pie is missing yField', () => {
    expect(
      buildG2Spec('pie', { xField: 'category' }, rows, columns),
    ).toBeNull();
  });

  it('handles empty rows (data: [])', () => {
    expect(
      buildG2Spec(
        'column',
        { xField: 'category', yField: 'value' },
        [],
        columns,
      ),
    ).toEqual({
      type: 'interval',
      data: [],
      encode: { x: 'category', y: 'value' },
    });
  });

  it('maps rows to objects keyed by columns (jest treats undefined props as absent)', () => {
    const shortRows: unknown[][] = [['a']]; // missing value + series
    const spec = buildG2Spec(
      'column',
      { xField: 'category', yField: 'value' },
      shortRows,
      columns,
    );
    expect(spec?.data).toEqual([{ category: 'a' }]);
  });
});
