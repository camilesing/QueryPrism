// json-value — coerce a stored Prisma JsonValue scalar to the string the
// frontend's {pval} contract expects. Used by the appearance + parameter
// modules (both map SystemVariable rows to {pkey=name, pval=...}). Avoids
// String() pitfalls: objects would render '[object Object]' and null would
// render 'null'; here objects serialize to JSON and null maps to '' (the
// frontend treats an empty pval as "unset → use default").
import { Prisma } from '@prisma/client';

/** Coerce a Prisma JsonValue scalar to a pval string. */
export function jsonValueToString(value: Prisma.JsonValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
