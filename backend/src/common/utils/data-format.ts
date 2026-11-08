// Data formatting helpers.
// Used to normalize column keys for chart configs and to format numbers.

// --- convertLargeNumbersInObjectArray. JS JSON.stringify renders |n| >= 1e21
// or |n| <= 1e-7 exponentially ("1e-7"), and the frontend number formatter
// only understands plain decimal strings — huge/tiny values would surface as
// scientific-notation junk in charts and exports. Thresholds:
//   - non-integer numbers with |v| >= 1e10 or |v| < 1e-6 → plain decimal
//     string
//   - integer-valued numbers with |v| >= intThreshold (1e15; Excel export
//     uses 1e11) → plain decimal string (beyond 2^53 the double cannot keep
//     precision). Integer-valued numbers below that stay numeric — JS cannot
//     tell an int column from a float column, and JSON.stringify stays plain
//     until 1e21, so keeping them numeric preserves chart axes.
// The expansion works on the SHORTEST round-trip repr (String(v)), then trims
// trailing fraction zeros — the value is preserved, never re-rounded.

/** |float| at or above this magnitude is stringified. */
const FLOAT_UPPER_THRESHOLD = 1e10;
/** |float| below this magnitude is stringified. */
const FLOAT_LOWER_THRESHOLD = 1e-6;
/** Default |int| stringification threshold (Excel export passes 1e11). */
const DEFAULT_INT_THRESHOLD = 1e15;

/** Expand a finite number into a plain decimal string with no exponent and
 *  no trailing fraction zeros. */
export function toPlainDecimal(v: number): string {
  if (v === 0) return '0'; // also covers -0
  const s = String(v); // shortest round-trip repr; exponent >= 1e21 / < 1e-6
  if (!/e/i.test(s)) return s;
  let mantissa = s.slice(0, s.search(/e/i));
  const exp = parseInt(s.slice(s.search(/e/i) + 1), 10);
  let neg = false;
  if (mantissa.startsWith('-')) {
    neg = true;
    mantissa = mantissa.slice(1);
  }
  const [intPart, fracPart = ''] = mantissa.split('.');
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let out: string;
  if (point <= 0) {
    out = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return (neg ? '-' : '') + out;
}

function convertNumber(v: number, intThreshold: number): string | number {
  if (!Number.isFinite(v)) return v; // JSON.stringify renders these null anyway
  const abs = Math.abs(v);
  if (Number.isInteger(v)) {
    return abs >= intThreshold ? toPlainDecimal(v) : v;
  }
  if (abs >= FLOAT_UPPER_THRESHOLD || abs < FLOAT_LOWER_THRESHOLD) {
    return toPlainDecimal(v);
  }
  return v;
}

/** Deep-convert one cell: numbers crossing a threshold become strings;
 *  nested objects/arrays are rebuilt, everything else passes through. */
function convertValue(value: unknown, intThreshold: number): unknown {
  if (typeof value === 'number') return convertNumber(value, intThreshold);
  if (Array.isArray(value)) {
    return value.map((v) => convertValue(v, intThreshold));
  }
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = convertValue(v, intThreshold);
    }
    return out;
  }
  return value;
}

/** Convert threshold-crossing numbers in every row (recursively) to plain
 *  decimal strings. Pure: returns new row objects, input rows untouched. */
export function convertLargeNumbersInObjectArray(
  rows: Record<string, unknown>[],
  intThreshold: number = DEFAULT_INT_THRESHOLD,
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = convertValue(v, intThreshold);
    }
    return out;
  });
}

/** Normalize an arbitrary column name into a safe field key for charts. */
export function normalizeColumnKey(key: string): string {
  let normalized = String(key)
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized || '_';
}

/** Format a number for display with thousands separators. */
export function formatNumber(value: number, fractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return String(value);
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}

/** True when a value represents an empty result set / blank cell. */
export function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
