import { describe, expect, it } from 'vitest';
import chunkRunId from '#layout/chunkRunId';

const win = { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') };

describe('chunkRunId', () => {
  it('writes every 6.1 row', () => {
    expect(chunkRunId('b', 'audit_log', 'timestamp-window', win)).toBe(
      'b-audit_log-timestamp-window-20260302T000000Z-20260303T000000Z'
    );

    expect(chunkRunId('b', 'orders', 'objectid-window', win)).toBe(
      'b-orders-objectid-window-20260302T000000Z-20260303T000000Z'
    );

    expect(chunkRunId('b', 'coupons', 'full-collection', null)).toBe(
      'b-coupons-full-collection-full'
    );

    expect(chunkRunId('b', 'audit_log', 'full-collection', null, 'rest')).toBe(
      'b-audit_log-full-collection-rest'
    );

    expect(chunkRunId('b', 'empty', 'manifest-only', null)).toBe('b-empty-manifest-only-full');

    expect(chunkRunId('b', 'empty', 'manifest-only', null, 'rest')).toBe(
      'b-empty-manifest-only-full'
    );
  });

  it('requires a window for windowed modes', () => {
    expect(() => chunkRunId('b', 'c', 'timestamp-window', null)).toThrow(RangeError);
  });
});
