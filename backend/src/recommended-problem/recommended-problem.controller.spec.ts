// RecommendedProblemController spec — locks the /recommended_problem surface.
// Three thin delegations: the admin list (parsed dsId), the chat-side base
// projection, and the replace-all save. Config merge logic lives in the
// service spec.
import { RecommendedProblemController } from './recommended-problem.controller';
import { RecommendedProblemService } from './recommended-problem.service';

describe('RecommendedProblemController', () => {
  let recommendedProblemService: {
    listByDatasource: jest.Mock;
    getBase: jest.Mock;
    save: jest.Mock;
  };
  let controller: RecommendedProblemController;

  beforeEach(() => {
    recommendedProblemService = {
      listByDatasource: jest.fn(),
      getBase: jest.fn(),
      save: jest.fn(),
    };
    controller = new RecommendedProblemController(
      recommendedProblemService as unknown as RecommendedProblemService,
    );
  });

  it('listByDatasource forwards the parsed datasource id', async () => {
    const rows = [{ id: 1, datasource_id: 2, question: 'q' }];
    recommendedProblemService.listByDatasource.mockResolvedValue(rows);
    await expect(controller.listByDatasource(2)).resolves.toEqual(rows);
    expect(recommendedProblemService.listByDatasource).toHaveBeenCalledWith(2);
  });

  it('getBase forwards the parsed datasource id', async () => {
    const base = { datasource_id: 2, recommended_config: {}, questions: [] };
    recommendedProblemService.getBase.mockResolvedValue(base);
    await expect(controller.getBase(2)).resolves.toEqual(base);
    expect(recommendedProblemService.getBase).toHaveBeenCalledWith(2);
  });

  it('save forwards the camelCase problemInfo body verbatim', async () => {
    const body = {
      datasource_id: 2,
      recommended_config: { limit: 5 },
      problemInfo: [{ question: 'q1' }],
    };
    const out = {
      datasource_id: 2,
      recommended_config: { limit: 5 },
      count: 1,
    };
    recommendedProblemService.save.mockResolvedValue(out);
    await expect(controller.save(body as never)).resolves.toEqual(out);
    expect(recommendedProblemService.save).toHaveBeenCalledWith(body);
  });
});
