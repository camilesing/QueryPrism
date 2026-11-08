import { detectQuestionLanguage } from './detect-language';

describe('detectQuestionLanguage', () => {
  const FALLBACK = 'zh-CN';

  it('returns zh-CN for a Chinese question', () => {
    expect(detectQuestionLanguage('查询销售额最高的部门', FALLBACK)).toBe(
      'zh-CN',
    );
  });

  it('returns en for an English question', () => {
    expect(
      detectQuestionLanguage('Show top departments by sales', 'zh-CN'),
    ).toBe('en');
  });

  it('prefers Chinese when the question mixes han and latin', () => {
    expect(detectQuestionLanguage('查询 sales 表的 total', FALLBACK)).toBe(
      'zh-CN',
    );
  });

  it('falls back when the question contains kana (Japanese, not Chinese)', () => {
    // 売上 is han, を/て are kana — kana must win over han.
    expect(detectQuestionLanguage('売上を教えて', 'fr')).toBe('fr');
  });

  it('falls back when the question contains hangul (Korean)', () => {
    expect(detectQuestionLanguage('매출을 보여줘', 'fr')).toBe('fr');
  });

  it('falls back for questions without letters (numbers/symbols only)', () => {
    expect(detectQuestionLanguage('123 + 456', FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for an empty question', () => {
    expect(detectQuestionLanguage('', FALLBACK)).toBe(FALLBACK);
  });
});
