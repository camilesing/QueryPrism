// renderChart — render a G2 5.x spec to a PNG Buffer using @antv/g2-ssr +
// node-canvas. The spec arrives over HTTP (parsed JSON), so it's typed as a
// loose record and cast to Options at the createChart boundary.
//
// API (verified against @antv/g2-ssr 0.2.0 dist/lib):
//   createChart(options: Options): Promise<Chart>   // async!
//   Chart.toBuffer(meta?): Buffer                   // sync
//   Chart.destroy(): void                           // sync
// Options = G2Spec & { width: number; height: number; imageType?: 'png'|'jpeg' }
import { createChart, type Options } from '@antv/g2-ssr';

export type G2Spec = Record<string, unknown>;

export interface RenderInput {
  spec: G2Spec;
  width?: number;
  height?: number;
}

export interface RenderOutput {
  buffer: Buffer;
}

/**
 * Render a G2 spec to a PNG Buffer. Throws if the spec is malformed (no mark
 * type) or if the native canvas libs are unavailable on the host.
 */
export async function renderChart(input: RenderInput): Promise<RenderOutput> {
  if (typeof input.spec.type !== 'string' || input.spec.type.length === 0) {
    throw new Error('spec.type is required');
  }
  const options = {
    ...input.spec,
    width: input.width ?? 640,
    height: input.height ?? 480,
    imageType: 'png' as const,
  } as unknown as Options;

  const chart = await createChart(options);
  try {
    const buffer = chart.toBuffer();
    return { buffer };
  } finally {
    chart.destroy();
  }
}
