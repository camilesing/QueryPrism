// nestjs-i18n resolver: prefers the authenticated user's stored language.
// ALS-based so it also works in guards/filters where the ExecutionContext
// is absent. Returns undefined when unresolvable → next resolver takes over
// (the I18nResolver signature does not accept null).
import type { ExecutionContext } from '@nestjs/common';
import type { I18nResolver } from 'nestjs-i18n';
import { RequestContext } from '../context/request-context';
import { normalizeLanguage } from './language';

export class UserLanguageResolver implements I18nResolver {
  resolve(_context?: ExecutionContext): string | undefined {
    return normalizeLanguage(RequestContext.getUser()?.language) ?? undefined;
  }
}
