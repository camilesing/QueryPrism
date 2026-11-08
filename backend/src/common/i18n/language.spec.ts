import { requestContextStorage } from '../context/request-context';
import { normalizeLanguage, resolveRequestLang } from './language';

describe('normalizeLanguage', () => {
  it.each(['zh-CN', 'zh_CN', 'zh', 'zh-Hans', 'zh-Hans-CN', 'ZH-CN'])(
    'maps %s to zh-CN',
    (input) => {
      expect(normalizeLanguage(input)).toBe('zh-CN');
    },
  );
  it.each(['en', 'EN', 'en-US', 'en_GB'])('maps %s to en', (input) => {
    expect(normalizeLanguage(input)).toBe('en');
  });
  it('returns null for unsupported or empty values', () => {
    expect(normalizeLanguage('ko-KR')).toBeNull();
    expect(normalizeLanguage('zh-TW')).toBeNull(); // trimmed locale — not supported
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });
});

describe('resolveRequestLang', () => {
  it('prefers the user profile language', () => {
    requestContextStorage.run(
      { user: { id: 1, account: 'a', oid: 1, language: 'zh_CN' } },
      () => {
        expect(resolveRequestLang()).toBe('zh-CN');
      },
    );
  });
  it('falls back to the accept-language header when no user', () => {
    requestContextStorage.run({ acceptLanguage: 'zh-CN,zh;q=0.9' }, () => {
      expect(resolveRequestLang()).toBe('zh-CN');
    });
  });
  it('falls back to en when nothing resolves', () => {
    requestContextStorage.run({}, () => {
      expect(resolveRequestLang()).toBe('en');
    });
    expect(resolveRequestLang()).toBe('en'); // outside any request scope
  });
  it('ignores an unsupported user language in favor of the header', () => {
    requestContextStorage.run(
      {
        user: { id: 1, account: 'a', oid: 1, language: 'ko-KR' },
        acceptLanguage: 'zh-CN',
      },
      () => {
        expect(resolveRequestLang()).toBe('zh-CN');
      },
    );
  });
});
