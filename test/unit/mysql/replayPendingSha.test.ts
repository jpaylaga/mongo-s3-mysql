import { describe, expect, it } from 'vitest';
import replayPendingSha from '#mysql/replayPendingSha';

describe('replayPendingSha', () => {
  it('fits the CHAR(64) ascii column and can never equal a real sha256', () => {
    expect(replayPendingSha).toHaveLength(64);
    expect(replayPendingSha).toMatch(/^replay-pending-0+$/);
    expect(/^[0-9a-f]{64}$/.test(replayPendingSha)).toBe(false);
  });
});
