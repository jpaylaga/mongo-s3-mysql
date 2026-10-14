import { describe, expect, it } from 'vitest';
import instantSchema from '../../../src/config/instantSchema.js';

describe('instantSchema', () => {
  it('needs an offset and no fraction, the form the plan freezes', () => {
    expect(instantSchema.safeParse('2026-10-12T00:00:00Z').success).toBe(true);
    expect(instantSchema.safeParse('2026-10-12T08:00:00+08:00').success).toBe(true);
    expect(instantSchema.safeParse('2026-10-12T00:00:00').success).toBe(false);
    expect(instantSchema.safeParse('2026-10-12T00:00:00.500Z').success).toBe(false);
  });
});
