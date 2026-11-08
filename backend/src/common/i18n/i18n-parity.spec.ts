// Guards the en/zh-CN dictionary pair: identical leaf-key sets and
// non-empty string values. Keys are prefixed by their JSON file's namespace
// (the same convention nestjs-i18n uses: <file>.<path...>).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = join(__dirname, '..', '..', 'i18n');

function files(lang: string): string[] {
  return readdirSync(join(base, lang)).filter((f) => f.endsWith('.json'));
}

function flatten(lang: string): string[] {
  const out: string[] = [];
  for (const f of files(lang)) {
    const ns = f.replace(/\.json$/, '');
    const walk = (obj: Record<string, unknown>, p: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === 'object') walk(v as Record<string, unknown>, key);
        else out.push(`${ns}.${key}`);
      }
    };
    walk(
      JSON.parse(readFileSync(join(base, lang, f), 'utf8')) as Record<
        string,
        unknown
      >,
      '',
    );
  }
  return out.sort();
}

describe('i18n dictionaries', () => {
  it('en and zh-CN expose identical file sets', () => {
    expect(files('zh-CN').sort()).toEqual(files('en').sort());
  });

  it('en and zh-CN expose identical key sets', () => {
    expect(flatten('zh-CN')).toEqual(flatten('en'));
  });

  it('every leaf in both languages is a non-empty string', () => {
    for (const lang of ['en', 'zh-CN']) {
      for (const f of files(lang)) {
        const walk = (obj: Record<string, unknown>, p: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object') {
              walk(v as Record<string, unknown>, p ? `${p}.${k}` : k);
            } else {
              expect(typeof v).toBe('string');
              expect(String(v).length).toBeGreaterThan(0);
            }
          }
        };
        walk(
          JSON.parse(readFileSync(join(base, lang, f), 'utf8')) as Record<
            string,
            unknown
          >,
          '',
        );
      }
    }
  });
});
