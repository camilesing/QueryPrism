// Spec for convertLargeNumbersInObjectArray / toPlainDecimal (the value must
// be preserved exactly when expanding scientific notation).
import {
  convertLargeNumbersInObjectArray,
  formatNumber,
  isBlank,
  normalizeColumnKey,
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

describe('toPlainDecimal — positive-exponent arms (coverage tail)', () => {
  it.each([
    [1.23e21, '1230000000000000000000'],
    [-1.23e21, '-1230000000000000000000'],
    [1e21, '1000000000000000000000'],
  ])('expands %p (String uses an exponent from 1e21)', (value, expected) => {
    // point = 1 + 21 >= digits.length → the zero-padded arm, no '.' to trim
    expect(toPlainDecimal(value)).toBe(expected);
  });
});

describe('convertLargeNumbersInObjectArray — non-finite passthrough (coverage tail)', () => {
  it('returns NaN / Infinity untouched (JSON.stringify renders them null)', () => {
    const out = convertLargeNumbersInObjectArray([
      { nan: NaN, inf: Infinity, ninf: -Infinity },
    ]);
    expect(out).toEqual([{ nan: NaN, inf: Infinity, ninf: -Infinity }]);
    expect(typeof out[0].nan).toBe('number');
    expect(typeof out[0].inf).toBe('number');
  });
});

describe('normalizeColumnKey (coverage tail)', () => {
  it('prefixes keys starting with a digit and rewrites unsafe characters', () => {
    expect(normalizeColumnKey('1st_order')).toBe('_1st_order');
    expect(normalizeColumnKey('2024sales')).toBe('_2024sales');
    expect(normalizeColumnKey(' Count% ')).toBe('Count_');
    expect(normalizeColumnKey('user-name#id')).toBe('user_name_id');
    expect(normalizeColumnKey('name')).toBe('name');
  });

  it('falls back to underscore when the key trims to nothing', () => {
    expect(normalizeColumnKey('')).toBe('_');
    expect(normalizeColumnKey('   ')).toBe('_');
    expect(normalizeColumnKey('***')).toBe('___'); // per-char rewrite keeps length
  });
});

describe('formatNumber (coverage tail)', () => {
  it('formats with thousands separators and capped fraction digits', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.89'); // default arg 2
    expect(formatNumber(1234567.8, 1)).toBe('1,234,567.8');
    expect(formatNumber(1000)).toBe('1,000'); // no forced fraction digits
    expect(formatNumber(-1234.5)).toBe('-1,234.5');
    expect(formatNumber(0.5)).toBe('0.5');
  });

  it('stringifies null / undefined / non-finite instead of formatting', () => {
    expect(formatNumber(null as unknown as number)).toBe('null');
    expect(formatNumber(undefined as unknown as number)).toBe('undefined');
    expect(formatNumber(NaN)).toBe('NaN');
    expect(formatNumber(Infinity)).toBe('Infinity');
  });
});

describe('isBlank (coverage tail)', () => {
  it('treats null, undefined, empty string and empty array as blank', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank([])).toBe(true);
  });

  it('treats present values (including 0, false, non-empty arrays) as not blank', () => {
    expect(isBlank('x')).toBe(false);
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
    expect(isBlank([1])).toBe(false);
    expect(isBlank({})).toBe(false);
  });
});
