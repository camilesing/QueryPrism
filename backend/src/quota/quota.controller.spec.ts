// QuotaController spec — locks the M7 budget admin surface. overview/remove
// are oid-scoped delegation; upsert re-packs the DTO into the service's
// snake body, normalizing an absent subject_id to null (the 'default'
// subject's sentinel). Budget math and reservation live in quota specs.
import { QuotaController } from './quota.controller';
import { QuotaService } from './quota.service';

describe('QuotaController', () => {
  let quota: {
    overview: jest.Mock;
    upsertBudget: jest.Mock;
    removeBudget: jest.Mock;
  };
  let controller: QuotaController;

  beforeEach(() => {
    quota = {
      overview: jest.fn(),
      upsertBudget: jest.fn(),
      removeBudget: jest.fn(),
    };
    controller = new QuotaController(quota as unknown as QuotaService);
  });

  it('overview is scoped to the caller oid', async () => {
    const data = { budgets: [], usages: [] };
    quota.overview.mockResolvedValue(data);
    await expect(controller.overview(7)).resolves.toEqual(data);
    expect(quota.overview).toHaveBeenCalledWith(7);
  });

  it('upsert re-packs the dto and forwards an explicit subject_id', async () => {
    quota.upsertBudget.mockResolvedValue({ success: true });
    const dto = {
      subject_type: 'user',
      subject_id: 42,
      daily_limit: 100000,
    } as never;

    await expect(controller.upsert(7, 3, dto)).resolves.toEqual({
      success: true,
    });
    expect(quota.upsertBudget).toHaveBeenCalledWith(7, 3, {
      subject_type: 'user',
      subject_id: 42,
      daily_limit: 100000,
    });
  });

  it('upsert normalizes an omitted subject_id to null (default subject)', async () => {
    quota.upsertBudget.mockResolvedValue({ success: true });
    const dto = {
      subject_type: 'default',
      daily_limit: 500000,
    } as never;

    await controller.upsert(7, 3, dto);
    expect(quota.upsertBudget).toHaveBeenCalledWith(7, 3, {
      subject_type: 'default',
      subject_id: null,
      daily_limit: 500000,
    });
  });

  it('remove forwards oid and the parsed budget-row id', async () => {
    quota.removeBudget.mockResolvedValue({ success: true });
    await expect(controller.remove(7, 15)).resolves.toEqual({ success: true });
    expect(quota.removeBudget).toHaveBeenCalledWith(7, 15);
  });
});
