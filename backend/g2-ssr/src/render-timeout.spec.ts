// renderChart against a createChart that never settles — what @antv/g2-ssr
// does whenever G2 throws while rendering. The library is mocked, so these
// run without canvas.
import { vi, afterEach, describe, expect, it } from 'vitest';

const createChart = vi.hoisted(() => vi.fn());
vi.mock('@antv/g2-ssr', () => ({ createChart }));

import { renderChart, RENDER_TIMEOUT_MS } from './render';
import { logUnhandledRejections } from './process-guards';

describe('renderChart when createChart never settles', () => {
  afterEach(() => {
    vi.useRealTimers();
    createChart.mockReset();
  });

  it('rejects after RENDER_TIMEOUT_MS instead of hanging the request', async () => {
    createChart.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const assertion = expect(
      renderChart({ spec: { type: 'line' } }),
    ).rejects.toThrow('render timed out');
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    await assertion;
  });

  it('destroys a chart that settles only after the request gave up', async () => {
    let settle: (chart: unknown) => void = () => {};
    const chart = { toBuffer: () => Buffer.alloc(0), destroy: vi.fn() };
    createChart.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    vi.useFakeTimers();
    const assertion = expect(
      renderChart({ spec: { type: 'line' } }),
    ).rejects.toThrow('render timed out');
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    await assertion;
    expect(chart.destroy).not.toHaveBeenCalled();

    vi.useRealTimers();
    settle(chart);
    await new Promise((resolve) => setImmediate(resolve));
    expect(chart.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not start the timer for a spec without a mark type', async () => {
    await expect(
      renderChart({ spec: { data: [] } }),
    ).rejects.toThrow('spec.type is required');
    expect(createChart).not.toHaveBeenCalled();
  });
});

describe('logUnhandledRejections', () => {
  it('installs a listener that logs the reason instead of crashing', () => {
    const before = process.listenerCount('unhandledRejection');
    const log = vi.fn();
    const listener = logUnhandledRejections(log);
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    const reason = new Error('Unknown Component: transform.stack');
    listener(reason);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('failed outside its request');
    expect(log.mock.calls[0][1]).toBe(reason);

    process.off('unhandledRejection', listener);
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
