// Thin facade over nestjs-i18n. One uniform call pattern for guards,
// filters, services and SSE generators — no constructor changes needed.
// The service reference is wired once at bootstrap (main.ts) and in tests
// (setI18n(createTestI18n())).
import type { I18nService } from 'nestjs-i18n';
import { resolveRequestLang } from './language';

let i18nRef: I18nService | null = null;

export function setI18n(service: I18nService | null): void {
  i18nRef = service;
}

/** Translate `key` in the current request language with `{{arg}}`
 *  interpolation. Returns the key itself when not wired yet (pre-bootstrap). */
export function tr(key: string, args?: Record<string, unknown>): string {
  if (!i18nRef) return key;
  return i18nRef.t(key, { lang: resolveRequestLang(), args });
}
