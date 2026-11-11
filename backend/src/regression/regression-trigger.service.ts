// RegressionTriggerService — the neutral port semantic/metric approvals use
// to schedule a regression run. It deliberately has NO dependency on
// ChatService/RegressionService: SemanticModule imports this module, while
// RegressionModule (the runner) imports ChatModule, so wiring the hook
// directly into RegressionService would close the cycle
// Regression → Chat → Semantic → Regression. Instead RegressionService
// registers its callback here at init (registerRunner); before that the
// trigger is a safe no-op (e.g. in unit tests that don't boot the runner).
import { Injectable, Logger } from '@nestjs/common';

export type RegressionRunLauncher = (
  oid: number,
  entityType: string,
  detail: Record<string, unknown>,
) => void;

@Injectable()
export class RegressionTriggerService {
  private readonly logger = new Logger(RegressionTriggerService.name);
  private launcher: RegressionRunLauncher | null = null;

  /** Called once by RegressionService.onModuleInit. */
  registerRunner(launcher: RegressionRunLauncher): void {
    this.launcher = launcher;
  }

  /** Fire-and-forget: a governance approval just changed semantic
   *  definitions — schedule a debounced regression run for the workspace.
   *  Never throws into the caller (the approval transaction must not care). */
  onApproval(
    oid: number,
    entityType: string,
    detail: Record<string, unknown>,
  ): void {
    if (!this.launcher) {
      this.logger.debug(
        `regression runner not registered; approval trigger for oid=${oid} ignored`,
      );
      return;
    }
    try {
      this.launcher(oid, entityType, detail);
    } catch (e) {
      this.logger.warn(
        `regression trigger failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
