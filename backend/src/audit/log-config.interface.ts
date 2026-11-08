import type { OperationModule, OperationType } from './operation.enum';

/** A snapshot of one resource affected by an audited operation. */
export interface LogResource {
  name?: string;
  originId?: string | number;
  originStr?: string;
}

/** Configuration attached via @SystemLog(...) to a handler. */
export interface LogConfig {
  module: OperationModule;
  type: OperationType;
  /** Static detail string; rendered as-is. */
  detail?: string;
  /**
   * Extract resource snapshots from the handler's return value (the raw data
   * BEFORE the TransformInterceptor wraps it, since interceptors run in
   * registration order: APP_INTERCEPTOR runs before module-level interceptors
   * if ordered last — we read the handler return directly).
   */
  resources?: (result: unknown) => LogResource[];
  /** Log even on success with status 'fail'? default false. */
  markFailWhen?: (result: unknown) => boolean;
}
