// Single-statement guard for read-only SQL execution. The connectors accept a
// statement by its FIRST keyword only (SELECT/WITH/...), but `pg` sends a
// string without bind parameters over the simple query protocol, where the
// server runs EVERY `;`-separated statement in it: `SELECT 1; DROP TABLE t;
// SELECT 1` passes the prefix check and drops the table. Separators inside
// string literals, quoted identifiers, dollar-quoted strings and comments do
// not count.
//
// Whether a backslash escapes the next quote depends on the dialect and on
// the server setting (PostgreSQL standard_conforming_strings), so the text is
// scanned under BOTH readings and reported as multiple when either one finds
// a second statement. The two readings can only disagree towards rejection.
import { tr } from '../../common/i18n/translate';

/** PostgreSQL dollar-quoted string opener: `$$` or `$tag$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Index of the first top-level statement separator under one backslash
 *  reading, and whether anything but whitespace/comments follows it. */
function scan(
  sql: string,
  backslashEscapes: boolean,
): { separator: number; contentAfter: boolean } {
  let i = 0;
  const n = sql.length;
  let separator = -1;
  let contentAfter = false;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const close = c;
      i++;
      while (i < n) {
        if (backslashEscapes && close !== '`' && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2; // doubled quote inside the literal
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? n : end + tag[0].length;
        continue;
      }
    } else if (
      c === '-' &&
      sql[i + 1] === '-' &&
      !/\S/.test(sql[i + 2] ?? '')
    ) {
      // `--` opens a comment only when whitespace follows (MySQL rule; the
      // stricter reading of the two dialects).
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    } else if (c === '/' && sql[i + 1] === '*' && sql[i + 2] !== '!') {
      // `/*! ... */` is executable in MySQL, so it is scanned as code.
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ';') {
      if (separator >= 0) {
        // A second separator is content by itself.
        return { separator, contentAfter: true };
      }
      separator = i;
    } else if (separator >= 0 && !/\s/.test(c)) {
      contentAfter = true;
    }
    i++;
  }
  return { separator, contentAfter };
}

/** True when `sql` holds more than one top-level statement. */
export function isMultiStatement(sql: string): boolean {
  return [true, false].some((backslashEscapes) => {
    const { separator, contentAfter } = scan(sql, backslashEscapes);
    return separator >= 0 && contentAfter;
  });
}

/** Throw the connectors' read-only error when `sql` is not exactly one
 *  statement (a single trailing `;` is fine). */
export function assertSingleStatement(sql: string): void {
  if (isMultiStatement(sql)) {
    throw new Error(tr('datasource.query_only'));
  }
}
