// McpController spec — locks the single POST /mcp route's error contract.
// The controller passes the PRE-PARSED req.body to the transport and guards
// the catch: before headersSent it writes the JSON-RPC error envelope itself
// (so the HttpExceptionFilter cannot double-write a Nest-style body); after
// headersSent it only logs and returns. Auth/transport behavior is covered by
// mcp.service.spec.
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

describe('McpController', () => {
  let mcp: { handleRequest: jest.Mock };
  let controller: McpController;
  let errorSpy: jest.SpyInstance;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    mcp = { handleRequest: jest.fn() };
    controller = new McpController(mcp as unknown as McpService);
    errorSpy = jest
      .spyOn((controller as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation();
    req = {
      headers: { authorization: 'Bearer tok' },
      body: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    } as unknown as Request;
    res = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;
  });

  afterEach(() => errorSpy.mockRestore());

  it('passes req, res and the pre-parsed body through to the service', async () => {
    mcp.handleRequest.mockResolvedValue(undefined);

    await controller.handle(req, res);

    expect(mcp.handleRequest).toHaveBeenCalledWith(req, res, req.body);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('writes the JSON-RPC error envelope when the service throws pre-headers', async () => {
    mcp.handleRequest.mockRejectedValue(new Error('transport blew up'));

    await controller.handle(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.setHeader).toHaveBeenCalledWith(
      'content-type',
      'application/json',
    );
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      }),
    );
  });

  it('only logs when the service throws after headers were sent', async () => {
    mcp.handleRequest.mockRejectedValue(new Error('late failure'));
    res.headersSent = true;

    await controller.handle(req, res);

    expect(errorSpy).toHaveBeenCalledWith(
      'MCP error after headersSent: late failure',
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
