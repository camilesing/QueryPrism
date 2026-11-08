// chart-object.builder spec — verifies the translation from the LLM's
// field-mapping config ({chartType, {xField,yField,seriesField?}}) into the
// chart-object shape the Vue frontend JSON.parses from record.chart /
// the SSE `chart` event. Pure-function assertions: exact literal objects.
import {
  buildQueryPrismChartObject,
  chartObjectToFieldMapping,
} from './chart-object.builder';

const columns = ['订单日期', '订单数', '订单总金额'];

describe('buildQueryPrismChartObject', () => {
  it('builds a line chart with x/y axes and no series', () => {
    expect(
      buildQueryPrismChartObject(
        'line',
        { xField: '订单日期', yField: '订单数' },
        columns,
      ),
    ).toEqual({
      type: 'line',
      title: '',
      axis: {
        x: { name: '订单日期', value: '订单日期' },
        y: [{ name: '订单数', value: '订单数' }],
      },
    });
  });

  it('adds the series axis when seriesField is present (column)', () => {
    expect(
      buildQueryPrismChartObject(
        'column',
        { xField: 'category', yField: 'value', seriesField: 'series' },
        ['category', 'value', 'series'],
      ),
    ).toEqual({
      type: 'column',
      title: '',
      axis: {
        x: { name: 'category', value: 'category' },
        y: [{ name: 'value', value: 'value' }],
        series: { name: 'series', value: 'series' },
      },
    });
  });

  it('maps bar with the same x/y axes (the frontend transposes it)', () => {
    expect(
      buildQueryPrismChartObject(
        'bar',
        { xField: 'category', yField: 'value' },
        ['category', 'value'],
      ),
    ).toEqual({
      type: 'bar',
      title: '',
      axis: {
        x: { name: 'category', value: 'category' },
        y: [{ name: 'value', value: 'value' }],
      },
    });
  });

  it('uses xField as the pie category and yField as the value', () => {
    expect(
      buildQueryPrismChartObject(
        'pie',
        { xField: 'category', yField: 'value' },
        ['category', 'value'],
      ),
    ).toEqual({
      type: 'pie',
      title: '',
      axis: {
        y: [{ name: 'value', value: 'value' }],
        series: { name: 'category', value: 'category' },
      },
    });
  });

  it('treats an explicit null seriesField as absent', () => {
    // The LLM prompt asks for "seriesField": null when there is no group field.
    expect(
      buildQueryPrismChartObject(
        'line',
        { xField: 'date', yField: 'count', seriesField: null },
        ['date', 'count'],
      ),
    ).toEqual({
      type: 'line',
      title: '',
      axis: {
        x: { name: 'date', value: 'date' },
        y: [{ name: 'count', value: 'count' }],
      },
    });
  });

  it('normalizes the chart type (case + surrounding whitespace)', () => {
    expect(
      buildQueryPrismChartObject(
        ' Line ',
        { xField: 'date', yField: 'count' },
        ['date', 'count'],
      ),
    ).toMatchObject({ type: 'line' });
  });

  it('prefers an explicit seriesField as the pie category', () => {
    expect(
      buildQueryPrismChartObject(
        'pie',
        { xField: 'region', yField: 'value', seriesField: 'category' },
        ['region', 'category', 'value'],
      ),
    ).toEqual({
      type: 'pie',
      title: '',
      axis: {
        y: [{ name: 'value', value: 'value' }],
        series: { name: 'category', value: 'category' },
      },
    });
  });

  it('builds a table chart from the SQL result columns', () => {
    expect(buildQueryPrismChartObject('table', {}, columns)).toEqual({
      type: 'table',
      title: '',
      columns: [
        { name: '订单日期', value: '订单日期' },
        { name: '订单数', value: '订单数' },
        { name: '订单总金额', value: '订单总金额' },
      ],
    });
  });

  it('falls back to a table when an axis chart lacks xField/yField', () => {
    expect(
      buildQueryPrismChartObject('line', { yField: 'value' }, ['value']),
    ).toEqual({
      type: 'table',
      title: '',
      columns: [{ name: 'value', value: 'value' }],
    });
  });

  it('falls back to a table for an unknown chart type', () => {
    expect(
      buildQueryPrismChartObject('radar', { xField: 'a', yField: 'b' }, [
        'a',
        'b',
      ]),
    ).toMatchObject({ type: 'table' });
  });

  it('keeps a title supplied by the LLM config', () => {
    expect(
      buildQueryPrismChartObject(
        'line',
        { title: '订单趋势', xField: 'a', yField: 'b' },
        ['a', 'b'],
      ).title,
    ).toBe('订单趋势');
  });
});

describe('chartObjectToFieldMapping', () => {
  it('recovers the field mapping from a line chart object', () => {
    expect(
      chartObjectToFieldMapping({
        type: 'line',
        axis: {
          x: { name: '日期', value: '日期' },
          y: [{ name: '订单数', value: '订单数' }],
        },
      }),
    ).toEqual({ xField: '日期', yField: '订单数', seriesField: undefined });
  });

  it('maps the pie series back to xField', () => {
    expect(
      chartObjectToFieldMapping({
        type: 'pie',
        axis: {
          y: [{ name: 'value', value: 'value' }],
          series: { name: 'category', value: 'category' },
        },
      }),
    ).toEqual({ xField: 'category', yField: 'value', seriesField: 'category' });
  });

  it('accepts a legacy single-object y axis and an empty chart', () => {
    expect(
      chartObjectToFieldMapping({
        axis: { x: { value: 'a' }, y: { value: 'b' } },
      }),
    ).toEqual({ xField: 'a', yField: 'b', seriesField: undefined });
    expect(chartObjectToFieldMapping({ type: 'table' })).toEqual({
      xField: undefined,
      yField: undefined,
      seriesField: undefined,
    });
  });
});
