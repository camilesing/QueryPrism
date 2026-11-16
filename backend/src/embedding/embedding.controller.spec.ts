// EmbeddingController spec — single delegation route: the manual null-
// embedding backfill trigger. The backfill logic itself is covered by
// embedding-backfill.service.spec; here we only pin the wiring.
import { EmbeddingController } from './embedding.controller';
import { EmbeddingBackfillService } from './embedding-backfill.service';

describe('EmbeddingController', () => {
  let backfillService: { run: jest.Mock };
  let controller: EmbeddingController;

  beforeEach(() => {
    backfillService = { run: jest.fn() };
    controller = new EmbeddingController(
      backfillService as unknown as EmbeddingBackfillService,
    );
  });

  it('backfill delegates to the backfill service', async () => {
    backfillService.run.mockResolvedValue({ processed: 12 });
    await expect(controller.backfill()).resolves.toEqual({ processed: 12 });
    expect(backfillService.run).toHaveBeenCalled();
  });
});
