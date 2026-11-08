// Test-only i18n stub: reads src/i18n/{en,zh-CN}/*.json so unit specs get
// real messages without bootstrapping the app. Not imported by prod code.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { I18nService } from 'nestjs-i18n';

type Dict = Record<string, unknown>;

function loadLang(lang: string): Dict {
  // __dirname = src/common/i18n → up two = src → src/i18n/<lang>
  const dir = join(__dirname, '..', '..', 'i18n', lang);
  const out: Dict = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    out[f.replace(/\.json$/, '')] = JSON.parse(
      readFileSync(join(dir, f), 'utf8'),
    );
  }
  return out;
}

const dicts: Record<string, Dict> = {
  en: loadLang('en'),
  'zh-CN': loadLang('zh-CN'),
};

function lookup(dict: Dict | undefined, key: string): string | undefined {
  const val = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Dict | undefined)?.[part], dict);
  return typeof val === 'string' ? val : undefined;
}

// Mirrors nestjs-i18n semantics: namespace = file name, {{arg}}
// interpolation, en fallback.
export function createTestI18n(): I18nService {
  return {
    t(
      key: string,
      options?: { lang?: string; args?: Record<string, unknown> },
    ) {
      const lang = options?.lang ?? 'en';
      let str = lookup(dicts[lang], key) ?? lookup(dicts.en, key) ?? key;
      if (options?.args) {
        for (const [k, v] of Object.entries(options.args)) {
          str = str.replaceAll(`{{${k}}}`, String(v));
        }
      }
      return str;
    },
  } as unknown as I18nService;
}
