import { describe, expect, it } from 'vitest';
import driftSample from '#reconcile/driftSample';

describe('driftSample', () => {
  it('is the number of example keys a drift detail names', () => {
    expect(driftSample).toBe(20);
  });
});
