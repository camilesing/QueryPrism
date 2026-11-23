// Process-level guards of the g2-ssr server.

/**
 * Keep serving when a render leaks a rejection.
 *
 * @antv/g2-ssr's createChart neither resolves nor rejects when G2 throws
 * while rendering (unknown component, missing encode, non-array data): the
 * rejection surfaces only as an unhandled one. Without a listener Node
 * terminates the process, and every later chart image is lost until a
 * restart. The request itself is answered by renderChart's timeout.
 *
 * Returns the listener so tests (or an embedder) can remove it again.
 */
export function logUnhandledRejections(
  log: (message: string, reason: unknown) => void = (message, reason) =>
    // eslint-disable-next-line no-console
    console.error(message, reason),
): (reason: unknown) => void {
  const listener = (reason: unknown): void => {
    log('[g2-ssr] a G2 render failed outside its request promise:', reason);
  };
  process.on('unhandledRejection', listener);
  return listener;
}
