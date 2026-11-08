// detect-language — pick the reply language for a chat turn from the
// question text itself (the profile language is only the fallback for
// scripts we don't recognize). Per-turn rule: Chinese question → 'zh-CN',
// Latin-script question → 'en'. Kana/hangul are checked BEFORE han because
// Japanese text mixes kanji with kana — a han-only test would misread it as
// Chinese. Everything else (numbers, symbols, other scripts) → `fallback`,
// which callers pass as the user's profile language.
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;
const HAN = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;

/** Detect the reply language for a question: han → 'zh-CN', latin → 'en',
 *  anything else (kana/hangul/symbols/empty) → `fallback`. */
export function detectQuestionLanguage(
  question: string,
  fallback: string,
): string {
  if (KANA.test(question) || HANGUL.test(question)) return fallback;
  if (HAN.test(question)) return 'zh-CN';
  if (LATIN.test(question)) return 'en';
  return fallback;
}
