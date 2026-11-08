// Dependency-free concurrency limiter. Mirrors the inline worker pool used by
// the embedding backfill (p-queue v9 is ESM-only and incompatible with the
// CJS backend). Used for background LLM tasks (batch generation / backfill).

/** Run an async fn over each item with at most `limit` in flight. Workers pull
 *  from a shared cursor so the total in-flight count never exceeds `limit`
 *  (clamped to the item count). Order of completion is not guaranteed; all
 *  items are processed. A thrown error rejects the whole batch. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
