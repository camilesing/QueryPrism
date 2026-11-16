// AuditController spec — locks the read-only /system/audit surface. page and
// getOptions are pure delegation; export is the @Res() xlsx branch: headers
// are set via res.set and the buffer goes out through res.send, which sets
// headersSent so TransformInterceptor bypasses the JSON envelope.
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import type { Response } from 'express';

describe('AuditController', () => {
  let audit: { page: jest.Mock; getOptions: jest.Mock; export: jest.Mock };
  let controller: AuditController;

  beforeEach(() => {
    audit = {
      page: jest.fn(),
      getOptions: jest.fn(),
      export: jest.fn(),
    };
    controller = new AuditController(audit as unknown as AuditService);
  });

  it('page forwards pager and the raw query object', async () => {
    const result = { data: [], total_count: 0 };
    audit.page.mockResolvedValue(result);
    const query = { module__in: 'chat', type__in: 'login' };
    await expect(controller.page(1, 20, query as never)).resolves.toEqual(
      result,
    );
    expect(audit.page).toHaveBeenCalledWith(1, 20, query);
  });

  it('page defaults the query to {} when omitted', async () => {
    audit.page.mockResolvedValue({ data: [], total_count: 0 });
    await controller.page(3, 10);
    expect(audit.page).toHaveBeenCalledWith(3, 10, {});
  });

  it('getOptions delegates to the service', () => {
    const options = [{ id: 'login', name: '登录' }];
    audit.getOptions.mockReturnValue(options);
    expect(controller.getOptions()).toEqual(options);
    expect(audit.getOptions).toHaveBeenCalled();
  });

  it('export streams the xlsx buffer with attachment headers', async () => {
    const buf = Buffer.from('xlsx-bytes');
    audit.export.mockResolvedValue(buf);
    const res = {
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;

    await controller.export({ module__in: 'user' } as never, res);

    expect(audit.export).toHaveBeenCalledWith({ module__in: 'user' });
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="system_log.xlsx"`,
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it('export defaults the query to {} when omitted', async () => {
    audit.export.mockResolvedValue(Buffer.alloc(0));
    const res = {
      set: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Response;
    await controller.export(undefined, res);
    expect(audit.export).toHaveBeenCalledWith({});
  });
});
