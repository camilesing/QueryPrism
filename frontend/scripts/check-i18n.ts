// Compares en.json and zh-CN.json — exits non-zero on
// key or interpolation-placeholder mismatches, printing the offending keys.
import { readFileSync } from 'node:fs'

type Dict = Record<string, unknown>

const read = (f: string): Dict =>
  JSON.parse(readFileSync(new URL(`../src/i18n/${f}`, import.meta.url), 'utf8'))
const en = read('en.json')
const zh = read('zh-CN.json')

const flatten = (obj: Dict, prefix = '', out: string[] = []): string[] => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v as Dict, key, out)
    // Empty strings are legal here: common.empty is a glue word
    // (a space in en, '' in zh).
    else if (typeof v !== 'string') out.push(`!INVALID:${key}`)
    else out.push(key)
  }
  return out
}

const enKeys = new Set(flatten(en))
const zhKeys = new Set(flatten(zh))
const missingZh = [...enKeys].filter((k) => !zhKeys.has(k))
const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))

if (missingZh.length || missingEn.length) {
  if (missingZh.length) console.error('Missing in zh-CN.json:\n  ' + missingZh.join('\n  '))
  if (missingEn.length) console.error('Missing in en.json:\n  ' + missingEn.join('\n  '))
  process.exit(1)
}
// Interpolation placeholders must match as well: a key taking {0} and {1}
// in one locale but only {0} in the other drops a value at runtime.
const flattenValues = (
  obj: Dict,
  prefix = '',
  out: Record<string, string> = {}
): Record<string, string> => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flattenValues(v as Dict, key, out)
    else if (typeof v === 'string') out[key] = v
  }
  return out
}
const enValues = flattenValues(en)
const zhValues = flattenValues(zh)
const placeholders = (text: string): string =>
  [...new Set(text.match(/\{[\w]+\}/g) ?? [])].sort().join(' ')
const mismatched = [...enKeys].filter(
  (k) => placeholders(enValues[k]) !== placeholders(zhValues[k])
)

if (mismatched.length) {
  console.error(
    'Interpolation placeholders differ:\n  ' +
      mismatched
        .map(
          (k) =>
            `${k}\n      en: ${JSON.stringify(enValues[k])}\n      zh: ${JSON.stringify(zhValues[k])}`
        )
        .join('\n  ')
  )
  process.exit(1)
}
console.log(`OK: ${enKeys.size} i18n keys aligned between en and zh-CN`)
