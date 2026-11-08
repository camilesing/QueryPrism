// Reasoning-tag parser for LLM content streams.
//
// DeepSeek-R1 / QwQ-style models often interleave their chain-of-thought
// inside  reasoning.../reasoning  blocks within the streamed `content`
// field (notably when served via vLLM/Ollama). The official DeepSeek/Qwen
// APIs instead surface reasoning as a separate `reasoning_content` field on
// the chunk's additional_kwargs — that path is handled by the caller
// (LlmService.stream); this module only concerns the in-content tag
// convention.
//
// The parser is a small state machine that tolerates a tag being split across
// chunk boundaries: any trailing substring that could be the start of a tag
// is held back until the next chunk resolves it (or flush emits it as literal
// content/reasoning). Tags are built from char codes so the literal tokens
// never appear as source text (avoids any environment display masking).

/** Open reasoning tag, e.g. `<think>` (built from char codes). */
export const OPEN_TAG = String.fromCharCode(60, 116, 104, 105, 110, 107, 62);
/** Close reasoning tag, e.g. `</think>` (built from char codes). */
export const CLOSE_TAG = String.fromCharCode(
  60,
  47,
  116,
  104,
  105,
  110,
  107,
  62,
);

export interface ReasoningDelta {
  contentDelta: string;
  reasoningDelta: string;
}

/** Longest suffix of `text` that is a proper prefix of `tag` (0 .. tag.length-1).
 *  Used to decide how much of a chunk tail to hold back as a potential
 *  half-tag. */
function longestSuffixPrefix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let L = max; L > 0; L--) {
    if (text.endsWith(tag.slice(0, L))) return L;
  }
  return 0;
}

/** Streaming reasoning-tag splitter. Feed content deltas in order, then call
 *  flush() once at the end. */
export class ReasoningParser {
  private inThink = false;
  private carry = '';

  feed(delta: string): ReasoningDelta {
    const text = this.carry + delta;
    this.carry = '';
    let contentDelta = '';
    let reasoningDelta = '';
    let i = 0;
    while (i < text.length) {
      const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = text.indexOf(tag, i);
      if (idx === -1) {
        // No (further) tag in the remaining text. Hold back any trailing
        // suffix that could be the start of the tag; emit the rest now.
        const hold = longestSuffixPrefix(text.slice(i), tag);
        const safe = text.length - hold;
        if (safe > i) {
          if (this.inThink) reasoningDelta += text.slice(i, safe);
          else contentDelta += text.slice(i, safe);
        }
        this.carry = hold > 0 ? text.slice(safe) : '';
        break;
      }
      if (this.inThink) reasoningDelta += text.slice(i, idx);
      else contentDelta += text.slice(i, idx);
      i = idx + tag.length;
      this.inThink = !this.inThink;
    }
    return { contentDelta, reasoningDelta };
  }

  /** Emit any held-back tail. An unclosed open tag at the very end leaves
   *  inThink true; the remaining text is treated as reasoning (the model
   *  closed implicitly). */
  flush(): ReasoningDelta {
    const tail = this.carry;
    this.carry = '';
    if (!tail) return { contentDelta: '', reasoningDelta: '' };
    if (this.inThink) return { contentDelta: '', reasoningDelta: tail };
    return { contentDelta: tail, reasoningDelta: '' };
  }
}

/** One-shot helper: split a complete content string into reasoning + content. */
export function splitReasoning(full: string): {
  reasoning: string;
  content: string;
} {
  const p = new ReasoningParser();
  const r = p.feed(full);
  const f = p.flush();
  return {
    reasoning: r.reasoningDelta + f.reasoningDelta,
    content: r.contentDelta + f.contentDelta,
  };
}
