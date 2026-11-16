// MetaController spec — locks the ApiKey-authenticated external ingestion
// surface. The controller validates each batch body (non-empty array, ≤5000
// rows) before delegating to the import services, and passes the ApiKeyGuard
// user straight to the regression trigger. Import/validation logic itself is
// covered by the semantic/metric import service specs.
import { BadRequestException } from '@nestjs/common';
import { MetaController } from './meta.controller';
import { SemanticImportService } from '../semantic/semantic-import.service';
import { MetricImportService } from '../semantic/metric-import.service';
import { RegressionService } from '../regression/regression.service';

describe('MetaController', () => {
  let importService: { importJson: jest.Mock };
  let metricImportService: {
    importJsonMetrics: jest.Mock;
    importJsonStandards: jest.Mock;
  };
  let regressionService: { startApiRun: jest.Mock };
  let controller: MetaController;

  beforeEach(() => {
    importService = { importJson: jest.fn() };
    metricImportService = {
      importJsonMetrics: jest.fn(),
      importJsonStandards: jest.fn(),
    };
    regressionService = { startApiRun: jest.fn() };
    controller = new MetaController(
      importService as unknown as SemanticImportService,
      metricImportService as unknown as MetricImportService,
      regressionService as unknown as RegressionService,
    );
  });

  describe('importSemantics', () => {
    it('delegates a valid row array to SemanticImportService.importJson', async () => {
      const rows = [{ table_name: 't1' }, { table_name: 't2' }];
      const result = { applied: 2, failed: [] };
      importService.importJson.mockResolvedValue(result);
      await expect(controller.importSemantics(rows as never)).resolves.toEqual(
        result,
      );
      expect(importService.importJson).toHaveBeenCalledWith(rows);
    });

    // The handler is sync — BadRequestException throws before a promise
    // exists, so these are plain sync throw assertions.
    it('rejects a non-array body', () => {
      expect(() =>
        controller.importSemantics({ table_name: 't1' } as never),
      ).toThrow(BadRequestException);
      expect(importService.importJson).not.toHaveBeenCalled();
    });

    it('rejects an empty array', () => {
      expect(() => controller.importSemantics([] as never)).toThrow(
        BadRequestException,
      );
      expect(importService.importJson).not.toHaveBeenCalled();
    });

    it('rejects a batch above 5000 rows', () => {
      expect(() =>
        controller.importSemantics(new Array(5001).fill({}) as never),
      ).toThrow(BadRequestException);
      expect(importService.importJson).not.toHaveBeenCalled();
    });
  });

  describe('importMetrics', () => {
    it('delegates a valid row array to MetricImportService.importJsonMetrics', async () => {
      const rows = [{ name: 'pv' }];
      const result = { applied: 1, failed: [] };
      metricImportService.importJsonMetrics.mockResolvedValue(result);
      await expect(controller.importMetrics(rows as never)).resolves.toEqual(
        result,
      );
      expect(metricImportService.importJsonMetrics).toHaveBeenCalledWith(rows);
    });

    it('rejects a non-array body', () => {
      expect(() => controller.importMetrics(null as never)).toThrow(
        BadRequestException,
      );
      expect(metricImportService.importJsonMetrics).not.toHaveBeenCalled();
    });

    it('rejects an empty array', () => {
      expect(() => controller.importMetrics([] as never)).toThrow(
        BadRequestException,
      );
      expect(metricImportService.importJsonMetrics).not.toHaveBeenCalled();
    });

    it('rejects a batch above 5000 rows', () => {
      expect(() =>
        controller.importMetrics(new Array(5001).fill({}) as never),
      ).toThrow(BadRequestException);
      expect(metricImportService.importJsonMetrics).not.toHaveBeenCalled();
    });
  });

  describe('importStandards', () => {
    it('delegates a valid row array to MetricImportService.importJsonStandards', async () => {
      const rows = [{ kind: 'unit', name: 'kg' }];
      const result = { applied: 1, failed: [] };
      metricImportService.importJsonStandards.mockResolvedValue(result);
      await expect(controller.importStandards(rows as never)).resolves.toEqual(
        result,
      );
      expect(metricImportService.importJsonStandards).toHaveBeenCalledWith(
        rows,
      );
    });

    it('rejects a non-array body', () => {
      expect(() => controller.importStandards('nope' as never)).toThrow(
        BadRequestException,
      );
      expect(metricImportService.importJsonStandards).not.toHaveBeenCalled();
    });

    it('rejects an empty array', () => {
      expect(() => controller.importStandards([] as never)).toThrow(
        BadRequestException,
      );
      expect(metricImportService.importJsonStandards).not.toHaveBeenCalled();
    });

    it('rejects a batch above 5000 rows', () => {
      expect(() =>
        controller.importStandards(new Array(5001).fill({}) as never),
      ).toThrow(BadRequestException);
      expect(metricImportService.importJsonStandards).not.toHaveBeenCalled();
    });
  });

  it('runRegression forwards the ApiKeyGuard user to startApiRun', async () => {
    const user = { id: 3, account: 'ci-bot', oid: 1 };
    const run = { runId: 11 };
    regressionService.startApiRun.mockResolvedValue(run);
    await expect(controller.runRegression(user as never)).resolves.toEqual(run);
    expect(regressionService.startApiRun).toHaveBeenCalledWith(user);
  });
});
