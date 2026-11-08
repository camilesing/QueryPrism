import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { SseWriter } from './sse-writer';

// The frontend SSE consumer uses regex `/data:.*}\n\n/g` +
// `str.replace('data:{','{')` + JSONBig.parse — it does NOT read `event:`
// lines. So SseWriter.send emits `data:<json>\n\n` with `type` merged into the
// JSON top-level LAST (QW1 — a `type` key inside data can never win). All
// payloads must be objects (the frontend regex requires a `{` after `data:`).
//
// 2026-09 review P2-3: close tracking (send/ping no-op after 'close'),
// backpressure (send awaits 'drain' when write() returns false).

interface FakeRes {
  chunks: string[];
  headers: Record<string, string>;
  ended: boolean;
  flushed: boolean;
  emitter: EventEmitter;
  writeReturns: boolean;
}

function fakeRes(): Response & FakeRes {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    chunks,
    headers,
    emitter,
    ended: false,
    flushed: false,
    writeReturns: true,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    write: (chunk: string) => {
      chunks.push(chunk);
      return res.writeReturns;
    },
    end: () => {
      res.ended = true;
      return res;
    },
    flushHeaders: () => {
      res.flushed = true;
    },
    get writableEnded() {
      return res.ended;
    },
  } as unknown as Response & FakeRes;
  return res;
}

describe('SseWriter', () => {
  it('sets text/event-stream headers and flushes on construction', () => {
    const res = fakeRes();
    new SseWriter(res);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['Cache-Control']).toBe('no-cache');
    expect(res.headers['Connection']).toBe('keep-alive');
    expect(res.flushed).toBe(true);
  });

  it('send() writes a data: frame with type merged into the JSON (no event: line)', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    await w.send('sql', { sql: 'SELECT 1', tables: [] });
    // type is merged LAST (QW1) — JSON key order reflects the spread order.
    expect(res.chunks.join('')).toBe(
      'data:{"sql":"SELECT 1","tables":[],"type":"sql"}\n\n',
    );
  });

  it("send() lets the EVENT type win over a 'type' key inside data (QW1)", async () => {
    // A payload carrying a hostile/accidental `type` must not hijack the
    // event type — the old `{ type, ...data }` spread let it.
    const res = fakeRes();
    const w = new SseWriter(res);
    await w.send('sql', { type: 'evil', sql: 'SELECT 1' });
    const parsed = JSON.parse(res.chunks.join('').replace('data:', '')) as {
      type: string;
      sql: string;
    };
    expect(parsed.type).toBe('sql');
    expect(parsed.sql).toBe('SELECT 1');
  });

  it('send() serializes an object payload with type merged in', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    await w.send('brief', { text: '查询完成' });
    expect(res.chunks.join('')).toBe(
      'data:{"text":"查询完成","type":"brief"}\n\n',
    );
  });

  it('send() keeps multi-line data in a single frame (JSON escapes \\n)', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    await w.send('error', { message: 'line1\nline2' });
    expect(res.chunks.join('')).toBe(
      'data:{"message":"line1\\nline2","type":"error"}\n\n',
    );
    expect(res.chunks.join('').split('\n\n')).toHaveLength(2);
  });

  it('send() is a NO-OP after the response closes (P2-3)', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    res.emitter.emit('close');
    expect(w.isClosed).toBe(true);
    await w.send('sql', { sql: 'SELECT 1' });
    expect(res.chunks).toHaveLength(0);
    w.ping();
    expect(res.chunks).toHaveLength(0);
  });

  it('send() awaits drain when write() reports backpressure (P2-3)', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    res.writeReturns = false; // buffer full — every write() returns false
    const pending = w.send('sql', { sql: 'SELECT 1' });
    // Still pending until 'drain' fires (no frame loss, no unbounded buffer).
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    res.emitter.emit('drain');
    await pending;
    expect(res.chunks.join('')).toContain('"type":"sql"');
  });

  it('a send() awaiting drain also resolves when the connection closes', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    res.writeReturns = false;
    const pending = w.send('sql', { sql: 'SELECT 1' });
    res.emitter.emit('close');
    await pending; // must not hang
  });

  it('ping() writes a comment heartbeat line', () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    w.ping();
    expect(res.chunks.join('')).toBe(': ping\n\n');
  });

  it('close() is safe after a client disconnect and ends exactly once', () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    res.emitter.emit('close'); // client already gone — must not throw
    w.close();
    const res2 = fakeRes();
    const w2 = new SseWriter(res2);
    w2.close();
    w2.close(); // idempotent — writableEnded guard skips the second end()
    expect(res2.ended).toBe(true);
  });

  it('multiple send() calls produce concatenated data: frames', async () => {
    const res = fakeRes();
    const w = new SseWriter(res);
    await w.send('id', { recordId: 1 });
    await w.send('sql_reasoning', { delta: 'thinking' });
    await w.send('finish', { recordId: 1 });
    expect(res.chunks.join('')).toBe(
      'data:{"recordId":1,"type":"id"}\n\n' +
        'data:{"delta":"thinking","type":"sql_reasoning"}\n\n' +
        'data:{"recordId":1,"type":"finish"}\n\n',
    );
  });
});
