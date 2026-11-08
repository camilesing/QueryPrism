// Spec for the dependency-free concurrency limiter. Mirrors the inline
// worker pool used by the embedding backfill (p-queue v9 is ESM-only and
// incompatible with the CJS backend).
import { mapWithConcurrency } from './task-pool';

describe('mapWithConcurrency', () => {
  it('runs every item and resolves on an empty input', async () => {
    const out: number[] = [];
    await mapWithConcurrency([], 3, (i) => {
      out.push(i);
      return Promise.resolve();
    });
    expect(out).toEqual([]);
  });

  it('processes all items', async () => {
    const out: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, (i) => {
      out.push(i);
      return Promise.resolve();
    });
    expect(out.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('clamps the worker count when items < limit', async () => {
    const out: number[] = [];
    await mapWithConcurrency([1, 2], 10, async (i) => {
      out.push(i);
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(out.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('propagates worker errors as a rejection', async () => {
    await expect(
      mapWithConcurrency([1], 1, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });
});
