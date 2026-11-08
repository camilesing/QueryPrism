// Spec for convertLargeNumbersInObjectArray / toPlainDecimal (the value must
// be preserved exactly when expanding scientific notation).
import {
  convertLargeNumbersInObjectArray,
  toPlainDecimal,
} from './data-format';
import {
  toQueryPrismDataShape,
  toQueryPrismListShape,
} from './queryprism-data-shape';

describe('toPlainDecimal', () => {
  it.each([
    [1.23e20, '123000000000000000000'],
    [-1.23e20, '-123000000000000000000'],
    [1.23e-10, '0.000000000123'],
    [-1.23e-10, '-0.000000000123'],
    [1e20, '100000000000000000000'],
    [1e-7, '0.0000001'],
    [1e10, '10000000000'],
    [12345678901.25, '12345678901.25'],
    [0, '0'],
    [-0, '0'],
  ])('expands %p without scientific notation', (value, expected) => {
    expect(toPlainDecimal(value)).toBe(expected);
  });
});

describe('convertLargeNumbersInObjectArray', () => {
  it.each([
    [1.23e20, '123000000000000000000'],
    [1e-7, '0.0000001'],
    [12345678901234.5, '12345678901234.5'],
    [12345678901.25, '12345678901.25'],
  ])('converts threshold-crossing floats (%p)', (value, expected) => {
    expect(convertLargeNumbersInObjectArray([{ value: value }])).toEqual([
      { value: expected },
    ]);
  });

  it('keeps integer-valued numbers below the int threshold numeric (JS divergence)', () => {
    // Python converts float(1e10) at the 1e10 float threshold because
    // json.dumps goes exponential from 1e16; JS JSON.stringify stays plain
    // until 1e21, and Number.isInteger can't tell an int column from a
    // float column — keeping these numeric preserves chart axes.
    expect(convertLargeNumbersInObjectArray([{ value: 1e10 }])).toEqual([
      { value: 1e10 },
    ]);
    expect(typeof convertLargeNumbersInObjectArray([{ v: 1e10 }])[0].v).toBe(
      'number',
    );
  });

  it('keeps values outside the conversion thresholds as numbers', () => {
    const row = {
      regular_float: 123.4,
      small_float_boundary: 1e-6,
      below_float_threshold: 9999999999.5,
      below_int_threshold: 999999999999999,
      large_integer: 1000000000000000,
      negative_integer: -1000000000000000,
      zero: 0,
      flag: true,
      text: '1.23e20',
      missing: null,
    };
    const converted = convertLargeNumbersInObjectArray([row])[0];
    expect(converted).toEqual({
      ...row,
      large_integer: '1000000000000000',
      negative_integer: '-1000000000000000',
    });
    expect(typeof converted.regular_float).toBe('number');
    expect(typeof converted.small_float_boundary).toBe('number');
    expect(typeof converted.below_float_threshold).toBe('number');
  });

  it('converts scientific notation inside nested rows', () => {
    const rows = [
      { metrics: { amount: 1.23e20 }, series: [{ value: 1.23e-10 }] },
    ];
    expect(convertLargeNumbersInObjectArray(rows)).toEqual([
      {
        metrics: { amount: '123000000000000000000' },
        series: [{ value: '0.000000000123' }],
      },
    ]);
    // input is not mutated
    expect(rows[0].metrics.amount).toBe(1.23e20);
  });

  it('supports the Excel int threshold override', () => {
    expect(
      convertLargeNumbersInObjectArray(
        [{ below: 99999999999, boundary: 100000000000, amount: 1.23e20 }],
        1e11,
      ),
    ).toEqual([
      {
        below: 99999999999,
        boundary: '100000000000',
        amount: '123000000000000000000',
      },
    ]);
  });
});

describe('queryprism-data-shape applies the numeric normalization', () => {
  it('toQueryPrismDataShape stringifies tiny/huge cell values', () => {
    const shape = toQueryPrismDataShape({
      columns: ['amount', 'ratio'],
      rows: [[1.23e20, 1e-7]],
    });
    expect(shape.data).toEqual([
      { amount: '123000000000000000000', ratio: '0.0000001' },
    ]);
  });

  it('toQueryPrismListShape normalizes predict rows too', () => {
    expect(toQueryPrismListShape([{ label: 'a', value: 1e-7 }])).toEqual([
      { label: 'a', value: '0.0000001' },
    ]);
  });
});
