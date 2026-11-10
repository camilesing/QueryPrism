// Natural-key write helper for the governed dictionaries (MetaDataImprove):
// the partial unique indexes created by migration
// 20261110130000_semantic_natural_key_unique are the DB-level guard behind
// SemanticService / GovernedDictService. A concurrent upsert that loses the
// create race gets Prisma P2002; retrying the WHOLE transaction once re-reads
// the winner and turns the attempt into a versioned update. A second failure
// (persistent conflict) surfaces as 409 instead of an unmapped 500.
//
// The retry callback must create a fresh $transaction; a failed interactive
// transaction is aborted and cannot be reused.

/** Structural P2002 check (unit tests mock plain objects, not Prisma errors). */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** Run `run`; on a unique violation run it once more in a fresh transaction.
 *  The caller supplies the friendly error thrown when the retry ALSO loses. */
export async function withNaturalKeyRetry<T>(
  run: () => Promise<T>,
  conflict: () => Error,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    try {
      return await run();
    } catch (retryError) {
      if (isUniqueConstraintError(retryError)) throw conflict();
      throw retryError;
    }
  }
}
