// renderChart spec — renders a real G2 spec to a PNG Buffer via @antv/g2-ssr
// + node-canvas. The native canvas binding needs cairo/pango on the host
// (see README). When those libs are absent we skip the whole suite rather
// than fail — the g2-ssr microservice is optional (decision §51: the MCP
// client degrades to {image:null}, so the backend four-gate must not depend
// on canvas being installed here).
import { renderChart } from './render';

function canvasAvailable(): boolean {
  try {
    // Touch the native canvas binding — throws on missing cairo/pango.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('canvas');
    return true;
  } catch {
    return false;
  }
}

const ok = canvasAvailable();
const maybe = ok ? describe : describe.skip;

maybe('renderChart', () => {
  it('renders an interval (bar) spec to a PNG buffer', async () => {
    const result = await renderChart({
      spec: {
        type: 'interval',
        data: [
          { category: 'a', value: 10 },
          { category: 'b', value: 20 },
        ],
        encode: { x: 'category', y: 'value' },
      },
      width: 320,
      height: 240,
    });
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
    // PNG magic bytes: 89 50 4E 47.
    expect(result.buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('uses default 640x480 when width/height are omitted', async () => {
    const result = await renderChart({
      spec: {
        type: 'interval',
        data: [{ x: 'a', y: 1 }],
        encode: { x: 'x', y: 'y' },
      },
    });
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('renders a line spec', async () => {
    const result = await renderChart({
      spec: {
        type: 'line',
        data: [
          { x: 'a', y: 1 },
          { x: 'b', y: 2 },
        ],
        encode: { x: 'x', y: 'y' },
      },
    });
    expect(result.buffer.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });
});

describe('renderChart input validation', () => {
  // These don't need canvas — renderChart rejects before reaching createChart.
  it('rejects when the spec is missing a type', async () => {
    await expect(
      renderChart({ spec: { data: [] } as Record<string, unknown> }),
    ).rejects.toThrow();
  });
});
