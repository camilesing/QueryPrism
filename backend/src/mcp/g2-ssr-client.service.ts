// g2-ssr-client — thin HTTP client for the g2-ssr chart→PNG microservice
// (Phase 7). POSTs a G2 5.x spec to `<g2ssr.host>/render` and returns the
// base64 PNG. Every failure path (host unset, non-ok, missing image, network
// error) degrades to `{image: null}` so the MCP `mcp_question` tool simply
// omits the image content block instead of failing the whole tool call —
// g2-ssr is an optional rendering path (decision §51). Uses Node 24's global
// fetch; no axios/hyperagent dep.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { G2Spec } from '../chart/chart-spec.builder';

export interface RenderResult {
  /** base64-encoded PNG, or null when rendering was skipped/failed. */
  image: string | null;
  path?: string;
  url?: string;
}

@Injectable()
export class G2SsrClient {
  private readonly logger = new Logger(G2SsrClient.name);

  constructor(private readonly config: ConfigService) {}

  async render(
    spec: G2Spec,
    opts?: { width?: number; height?: number },
  ): Promise<RenderResult> {
    const host = this.config.get<string>('g2ssr.host');
    if (!host) return { image: null };
    try {
      const res = await fetch(`${host}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec,
          width: opts?.width,
          height: opts?.height,
        }),
      });
      if (!res.ok) return { image: null };
      const data = (await res.json()) as {
        image?: string;
        path?: string;
        url?: string;
      };
      if (!data.image) return { image: null };
      return { image: data.image, path: data.path, url: data.url };
    } catch (e) {
      this.logger.warn(
        `g2-ssr render failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { image: null };
    }
  }
}
