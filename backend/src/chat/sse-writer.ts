// SseWriter — wraps an express Response and writes Server-Sent Events frames.
//
// The frontend SSE consumer (fetchStream + getReader)
// parses frames with regex `/data:.*}\n\n/g`, then `str.replace('data:{','{')`
// + `JSONBig.parse`. It does NOT read `event:` lines. So each frame is a
// single `data:<json>\n\n` line with NO `event:` line; the event `type` is
// merged into the JSON top-level. All payloads must be JSON objects (the
// frontend regex requires a `{` immediately after `data:` — a bare-string
// payload like `data:"x"\n\n` would not match and would be silently dropped).
//
// 2026-09 review P2-3 hardening:
//  - close tracking via res.on('close') — send()/ping() become no-ops after
//    the client disconnects (post-disconnect writes used to buffer/crash);
//    isClosed lets the draining loop stop consuming a dead stream.
//  - backpressure — when res.write() returns false the buffer is full;
//    send() awaits 'drain' (or 'close') instead of buffering unboundedly
//    during long LLM streams.
import { once } from 'node:events';
import type { Response } from 'express';

export class SseWriter {
  private closed = false;

  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Nest/Express default POST status is 201; SSE must be 200. Set it before
    // flushing so the first frame carries the right status line.
    res.statusCode = 200;
    res.flushHeaders();
    // Fires on client disconnects AND on normal end() — either way, no more
    // frames may be written.
    res.on('close', () => {
      this.closed = true;
    });
  }

  /** True once the response closed (client disconnect or stream end) — the
   *  draining loop checks this to stop pulling from the LLM generator. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Write one event as `data:<json>\n\n`. The `type` is merged into the JSON
   *  top-level LAST — a `type` key inside `data` can never override the event
   *  type (QW1). `data` must be a plain object so the frontend regex
   *  (`data:{`) matches. JSON escapes `\n` inside string values, so each
   *  event is a single frame. No-op after close; awaits the socket drain
   *  when the write buffer is full (backpressure). */
  async send(type: string, data: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const ok = this.res.write(
      'data:' + JSON.stringify({ ...data, type }) + '\n\n',
    );
    if (!ok) {
      await Promise.race([once(this.res, 'drain'), once(this.res, 'close')]);
    }
  }

  /** SSE comment line — keeps idle proxies/load balancers from closing the
   *  connection during long LLM calls (wired as a keep-alive interval by the
   *  chat controller's stream loop). */
  ping(): void {
    if (this.closed) return;
    this.res.write(': ping\n\n');
  }

  close(): void {
    this.closed = true;
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }
}
