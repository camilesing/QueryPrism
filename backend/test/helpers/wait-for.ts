// Bounded poll helper (batch 7 test hygiene): replaces the fixed 100ms sleeps
// that raced the fire-and-forget @SystemLog audit writes. Polls `fn` until
// `pred` passes; on timeout returns the LAST value so the caller's own
// assertions produce the failure message (never throws a bare "timeout").
// PostgreSQL's first write after app bootstrap can take longer than SQLite's,
// so allow up to ~4s.
export async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 40;
  const delayMs = opts.delayMs ?? 100;
  let v = await fn();
  for (let i = 0; i < attempts - 1 && !pred(v); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    v = await fn();
  }
  return v;
}
