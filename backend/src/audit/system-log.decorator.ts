import { SetMetadata } from '@nestjs/common';
import type { LogConfig } from './log-config.interface';

export const SYSTEMLOG_KEY = 'systemLog';

/** Attach audit-log config to a handler (method-level). */
export const SystemLog = (config: LogConfig) =>
  SetMetadata(SYSTEMLOG_KEY, config);
