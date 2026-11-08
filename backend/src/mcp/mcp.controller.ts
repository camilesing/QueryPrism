// McpController — the single POST /api/v1/mcp route. Delegates to McpService,
// which authenticates the Bearer integration token, then drives the
// StreamableHTTPServerTransport with a PRE-PARSED body (req.body, already
// consumed by Nest's json() body parser). This is the key trick (decision
// §45): handleRequest(req, res, parsedBody) skips the transport's own stream
// read, so Nest's body parser and the MCP transport never fight over the raw
// request stream.
//
// @Res() is non-passthrough → Nest does NOT auto-send, the transport owns the
// response; the TransformInterceptor's headersSent guard (§18) makes the
// envelope bypass explicit. try/catch guards against the HttpExceptionFilter
// double-writing once the transport has already sent headers.
import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpService } from './mcp.service';

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.mcp.handleRequest(req, res, req.body);
    } catch (e) {
      if (res.headersSent) {
        this.logger.error(
          `MCP error after headersSent: ${(e as Error).message}`,
        );
        return;
      }
      res
        .status(500)
        .setHeader('content-type', 'application/json')
        .end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
    }
  }
}
