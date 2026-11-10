// Natural-key retry helper (MetaDataImprove): a concurrent create race yields
// Prisma P2002; the helper reruns the whole transaction once.
import { ConflictException } from '@nestjs/common';
import { isUniqueConstraintError, withNaturalKeyRetry } from './natural-key';

const duplicate = (): Error =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('natural-key retry', () => {
  it('detects P2002 structurally and ignores other errors', () => {
    expect(isUniqueConstraintError(duplicate())).toBe(true);
    expect(isUniqueConstraintError({ code: 'P2003' })).toBe(false);
    expect(isUniqueConstraintError(new Error('boom'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });

  it('retries once after a unique violation and returns the retry result', async () => {
    const run = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce('ok');
    const conflict = jest.fn(() => new ConflictException('conflict'));
    await expect(withNaturalKeyRetry(run, conflict)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    expect(conflict).not.toHaveBeenCalled();
  });

  it('throws the friendly conflict when the retry also loses', async () => {
    const run = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(duplicate())
      .mockRejectedValueOnce(duplicate());
    const conflict = jest.fn(() => new ConflictException('conflict'));
    await expect(withNaturalKeyRetry(run, conflict)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(conflict).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-unique errors', async () => {
    const run = jest
      .fn<Promise<string>, []>()
      .mockRejectedValue(new Error('x'));
    const conflict = jest.fn(() => new ConflictException('conflict'));
    await expect(withNaturalKeyRetry(run, conflict)).rejects.toThrow('x');
    expect(run).toHaveBeenCalledTimes(1);
    expect(conflict).not.toHaveBeenCalled();
  });
});
