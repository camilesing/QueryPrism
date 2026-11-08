// parseStrictInt spec — the coercion matrix from the 2026-09 review (P2-1):
// every value class the old `Number()` + isNaN guards let through wrongly.
import { parseStrictInt } from './parse-int';

describe('parseStrictInt', () => {
  it('accepts real integers', () => {
    expect(parseStrictInt(0)).toBe(0);
    expect(parseStrictInt(42)).toBe(42);
    expect(parseStrictInt(-7)).toBe(-7);
  });

  it('accepts pure decimal-digit strings (with optional sign)', () => {
    expect(parseStrictInt('42')).toBe(42);
    expect(parseStrictInt(' 7 ')).toBe(7);
    expect(parseStrictInt('-3')).toBe(-3);
    expect(parseStrictInt('+9')).toBe(9);
    expect(parseStrictInt('0')).toBe(0);
  });

  it('rejects the Number() coercion traps', () => {
    expect(parseStrictInt('')).toBeNull(); // Number('')===0
    expect(parseStrictInt('   ')).toBeNull();
    expect(parseStrictInt(null)).toBeNull(); // Number(null)===0
    expect(parseStrictInt(undefined)).toBeNull();
    expect(parseStrictInt(true)).toBeNull(); // Number(true)===1
    expect(parseStrictInt(false)).toBeNull();
    expect(parseStrictInt([])).toBeNull(); // Number([])===0
    expect(parseStrictInt([7])).toBeNull(); // Number([7])===7 (!)
    expect(parseStrictInt({})).toBeNull();
  });

  it('rejects floats, exponent/hex forms, and junk strings', () => {
    expect(parseStrictInt('1.5')).toBeNull();
    expect(parseStrictInt(1.5)).toBeNull();
    expect(parseStrictInt('1e3')).toBeNull(); // implicitly 1000 via Number()
    expect(parseStrictInt('0x10')).toBeNull(); // implicitly 16 via Number()
    expect(parseStrictInt('12abc')).toBeNull();
    expect(parseStrictInt('abc')).toBeNull(); // NaN via Number()
    expect(parseStrictInt('Infinity')).toBeNull();
  });

  it('rejects values outside the safe-integer range', () => {
    expect(parseStrictInt('9007199254740993')).toBeNull(); // 2^53+1
    expect(parseStrictInt(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
