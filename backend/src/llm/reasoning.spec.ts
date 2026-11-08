// Spec for the streaming reasoning-tag parser. DeepSeek/R1-style models
// interleave reasoning blocks in the content stream; this parser splits
// them into reasoning vs. visible content, even when a tag is split across
// chunk boundaries. Tags come from the impl (char-code built) so spec and
// impl always reference identical bytes.
import {
  CLOSE_TAG,
  OPEN_TAG,
  ReasoningParser,
  splitReasoning,
} from './reasoning';

describe('splitReasoning (one-shot)', () => {
  it('passes plain content through untouched', () => {
    expect(splitReasoning('no tags here')).toEqual({
      reasoning: '',
      content: 'no tags here',
    });
  });

  it('extracts a single think block', () => {
    expect(
      splitReasoning(`PREFIX${OPEN_TAG}REASONING${CLOSE_TAG}SUFFIX`),
    ).toEqual({
      reasoning: 'REASONING',
      content: 'PREFIXSUFFIX',
    });
  });

  it('handles multiple interleaved blocks', () => {
    expect(
      splitReasoning(`${OPEN_TAG}r1${CLOSE_TAG}c1${OPEN_TAG}r2${CLOSE_TAG}c2`),
    ).toEqual({
      reasoning: 'r1r2',
      content: 'c1c2',
    });
  });

  it('treats an unclosed think block as trailing reasoning', () => {
    expect(splitReasoning(`c1${OPEN_TAG}unfinished reasoning`)).toEqual({
      reasoning: 'unfinished reasoning',
      content: 'c1',
    });
  });

  it('handles empty input', () => {
    expect(splitReasoning('')).toEqual({ reasoning: '', content: '' });
  });

  it('does not mistake a stray < as a tag', () => {
    expect(splitReasoning('a < b && c > d')).toEqual({
      reasoning: '',
      content: 'a < b && c > d',
    });
  });
});

describe('ReasoningParser (streaming, tag split across chunks)', () => {
  function drain(parts: string[]) {
    const p = new ReasoningParser();
    const out = { content: '', reasoning: '' };
    for (const part of parts) {
      const r = p.feed(part);
      out.content += r.contentDelta;
      out.reasoning += r.reasoningDelta;
    }
    const f = p.flush();
    out.content += f.contentDelta;
    out.reasoning += f.reasoningDelta;
    return out;
  }

  it('reassembles a tag split right at the open boundary', () => {
    const parts = [
      `PREFIX${OPEN_TAG.slice(0, 4)}`,
      `${OPEN_TAG.slice(4)}REASONING${CLOSE_TAG}SUFFIX`,
    ];
    expect(drain(parts)).toEqual({
      reasoning: 'REASONING',
      content: 'PREFIXSUFFIX',
    });
  });

  it('reassembles a tag split at the close boundary', () => {
    const parts = [
      `${OPEN_TAG}REASONING${CLOSE_TAG.slice(0, 5)}`,
      `${CLOSE_TAG.slice(5)}TAIL`,
    ];
    expect(drain(parts)).toEqual({
      reasoning: 'REASONING',
      content: 'TAIL',
    });
  });

  it('reassembles a tag split token-by-token', () => {
    const parts = [...OPEN_TAG.split(''), 'R', ...CLOSE_TAG.split(''), 'END'];
    expect(drain(parts)).toEqual({ reasoning: 'R', content: 'END' });
  });

  it('streams content deltas as they arrive', () => {
    const p = new ReasoningParser();
    expect(p.feed('hello ').contentDelta).toBe('hello ');
    expect(p.feed('world').contentDelta).toBe('world');
    p.flush();
  });

  it('holds back a partial open tag until the next chunk resolves it', () => {
    const p = new ReasoningParser();
    // ends with a partial open-tag prefix that is NOT completed into a tag
    const r1 = p.feed('visible<');
    expect(r1.contentDelta).toBe('visible'); // '<' held back
    const r2 = p.feed(' not-a-tag');
    expect(r2.contentDelta).toBe('< not-a-tag');
    p.flush();
  });

  it('matches the one-shot splitter on a complex stream', () => {
    const text = `start${OPEN_TAG}plan${CLOSE_TAG}do${OPEN_TAG}reflect${CLOSE_TAG}end < b unclosed`;
    expect(drain(Array.from(text))).toEqual(splitReasoning(text));
  });
});
