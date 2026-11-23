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

/** Upper bound for one render. The backend's G2SsrClient gives up after
 *  10 s, so a slower image is never seen anyway. It matters because a render
 *  G2 aborts (unknown component, missing encode, non-array data) NEVER
 *  settles: @antv/g2-ssr drops that rejection instead of rejecting its own
 *  promise (see the unhandledRejection listener in server.ts). */
export const RENDER_TIMEOUT_MS = 8_000;

export class RenderTimeoutError extends Error {
  constructor() {
    super('render timed out');
  }
}

/**
 * Render a G2 spec to a PNG Buffer. Throws if the spec is malformed (no mark
 * type), if G2 rejects it after RENDER_TIMEOUT_MS, or if the native canvas
 * libs are unavailable on the host.
 *
 * Known limitation: a render that G2 aborts keeps its canvas. The promise
 * never settles, so there is no chart handle to destroy; only toBuffer()
 * (synchronous) and the async phase up to the timeout are bounded.
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

  const created = createChart(options);
  let abandoned = false;
  // A chart that settles only after the caller gave up must not stay alive.
  created.then(
    (late) => {
      if (abandoned) late.destroy();
    },
    () => undefined,
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    const chart = await Promise.race([
      created,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError()), RENDER_TIMEOUT_MS);
      }),
    ]);
    try {
      return { buffer: chart.toBuffer() };
    } finally {
      chart.destroy();
    }
  } catch (e) {
    abandoned = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
