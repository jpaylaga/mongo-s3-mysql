import { describe, expect, it } from 'vitest';
import driftSample from '../../../src/reconcile/driftSample.js';

describe('driftSample', () => {
  it('is the number of example keys a drift detail names', () => {
    expect(driftSample).toBe(20);
  });
});
