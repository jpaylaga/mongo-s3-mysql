import { describe, expect, it } from 'vitest';
import floorTo from '../../../src/runtime/floorTo.js';

describe('floorTo', () => {
  it('rounds down to the UTC hour or day grid', () => {
    expect(floorTo(new Date('2026-10-13T02:03:04Z'), 3_600_000).toISOString()).toBe('2026-10-13T02:00:00.000Z');
    expect(floorTo(new Date('2026-10-13T02:03:04Z'), 86_400_000).toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(floorTo(new Date('2026-10-13T00:00:00Z'), 86_400_000).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });
});
