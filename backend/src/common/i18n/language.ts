// Language normalization + the request language resolution chain:
// user profile (ALS) → Accept-Language header (ALS) → 'en'.
import { RequestContext } from '../context/request-context';

export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** Map any stored/header language tag onto the supported set, or null. */
export function normalizeLanguage(
  input: string | null | undefined,
): SupportedLanguage | null {
  if (!input) return null;
  const tag = input.trim().replace('_', '-').toLowerCase();
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  if (tag === 'zh' || tag.startsWith('zh-hans')) return 'zh-CN';
  if (tag === 'zh-cn' || tag === 'zh-sg') return 'zh-CN';
  return null;
}

/** Resolve the language for the current request: user profile first, then
 *  the raw Accept-Language header stored by RequestContextMiddleware, then
 *  the default. Reads the first q-value of a comma-separated header. */
export function resolveRequestLang(): SupportedLanguage {
  const user = normalizeLanguage(RequestContext.getUser()?.language);
  if (user) return user;
  const raw = RequestContext.current()?.acceptLanguage;
  const first = typeof raw === 'string' ? raw.split(',')[0] : null;
  return normalizeLanguage(first) ?? DEFAULT_LANGUAGE;
}
