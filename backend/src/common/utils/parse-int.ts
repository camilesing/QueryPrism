// parseStrictInt — the ONE integer-parse utility (2026-09 review P2-1).
// Replaces every ad-hoc `Number(x)` + isNaN/isFinite guard, all of which let
// `Number('')===0`, `Number(null)===0`, `Number(true)===1`, `Number('1.5')`,
// `Number('-1')`, and `Number('0x10')===16` through — the review traced these
// to real bugs (blank keyword binding user id 0, '"abc"' ids silently
// falling into CREATE branches, fabricated ids like [0,0,1]).
//
// Accepts ONLY: a real integer, or a string of optional-sign decimal digits
// within the safe-integer range. Everything else → null.

export function parseStrictInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null; // null/undefined/boolean/object/array — no coercion
  }
  const s = value.trim();
  if (!/^[+-]?\d+$/.test(s)) {
    return null; // rejects '', '1.5', '1e3', '0x10', '12abc', ' '
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
