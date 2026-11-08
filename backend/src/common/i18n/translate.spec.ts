import { requestContextStorage } from '../context/request-context';
import { setI18n, tr } from './translate';
import { createTestI18n } from './test-i18n';

describe('tr()', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('translates with the request language and interpolates args', () => {
    requestContextStorage.run(
      { user: { id: 1, account: 'a', oid: 1, language: 'zh-CN' } },
      () => {
        expect(tr('auth.token_expired')).toBe('登录已过期，请重新登录');
      },
    );
    requestContextStorage.run({}, () => {
      expect(tr('common.internal_error')).toBe('Internal server error');
    });
  });

  it('returns the key when no i18n service is wired', () => {
    setI18n(null);
    expect(tr('auth.not_logged_in')).toBe('auth.not_logged_in');
  });
});
