// Retry policy of the HTTP client (src/utils/request.ts): pure, so it can be
// checked without a browser or a test runner.
import type { RequestOptions } from './request'

/** Attempts allowed for a request that failed with a retryable status. */
export function maxRetryAttempts(
  method: string | undefined,
  requestOptions: RequestOptions | undefined
): number {
  // An explicit count wins, and 0 means "never retry" (`retryCount || 3` used
  // to turn that 0 back into 3).
  if (requestOptions?.retryCount !== undefined) return requestOptions.retryCount
  // Only idempotent verbs retry on their own: a 502 from a proxy does not
  // tell whether the upstream already ran the request, and replaying a POST
  // (create datasource, import Excel, send a chat message…) can perform it
  // twice.
  return IDEMPOTENT_METHODS.includes(method?.toLowerCase() ?? '') ? 3 : 0
}

const IDEMPOTENT_METHODS = ['get', 'head', 'options', 'put', 'delete']
