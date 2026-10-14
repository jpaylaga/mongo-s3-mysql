import { describe, expect, it } from 'vitest';
import durations from '../../../src/runtime/durations.js';

describe('durations', () => {
  it('names the hour and the day in milliseconds', () => {
    expect(durations.hourMs).toBe(60 * 60 * 1000);
    expect(durations.dayMs).toBe(24 * durations.hourMs);
  });
});
