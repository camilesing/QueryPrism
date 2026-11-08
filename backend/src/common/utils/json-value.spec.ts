// json-value spec — the {pkey, pval} contract coerces a stored Prisma
// JsonValue scalar to the string pval the frontend expects. Guards the
// edge cases String() would get wrong ([object Object], 'null').
import { jsonValueToString } from './json-value';

describe('jsonValueToString', () => {
  it('passes strings through unchanged', () => {
    expect(jsonValueToString('QueryPrism')).toBe('QueryPrism');
    expect(jsonValueToString('0')).toBe('0');
  });

  it('stringifies numbers and booleans', () => {
    expect(jsonValueToString(3)).toBe('3');
    expect(jsonValueToString(true)).toBe('true');
    expect(jsonValueToString(false)).toBe('false');
  });

  it('maps null to empty string (frontend treats unset as default)', () => {
    expect(jsonValueToString(null)).toBe('');
  });

  it('serializes objects/arrays to JSON instead of [object Object]', () => {
    expect(jsonValueToString({ a: 1 })).toBe('{"a":1}');
    expect(jsonValueToString([1, 2])).toBe('[1,2]');
  });
});
