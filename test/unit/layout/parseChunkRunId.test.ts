import { describe, expect, it } from 'vitest';
import chunkRunId from '#layout/chunkRunId';
import parseChunkRunId from '#layout/parseChunkRunId';

const win = { start: new Date('2026-03-02T00:00:00Z'), end: new Date('2026-03-03T00:00:00Z') };

describe('parseChunkRunId', () => {
  it('round-trips every chunkRunId form', () => {
    expect(parseChunkRunId(chunkRunId('b', 'c', 'timestamp-window', win), 'b', 'c')).toEqual({
      mode: 'timestamp-window',
      window: win,
      tail: 'window',
    });

    expect(parseChunkRunId(chunkRunId('b', 'c', 'objectid-window', win), 'b', 'c')).toEqual({
      mode: 'objectid-window',
      window: win,
      tail: 'window',
    });

    expect(parseChunkRunId(chunkRunId('b', 'c', 'full-collection', null), 'b', 'c')).toEqual({
      mode: 'full-collection',
      window: null,
      tail: 'full',
    });

    expect(
      parseChunkRunId(chunkRunId('b', 'c', 'full-collection', null, 'rest'), 'b', 'c')
    ).toEqual({ mode: 'full-collection', window: null, tail: 'rest' });

    expect(parseChunkRunId(chunkRunId('b', 'c', 'manifest-only', null), 'b', 'c')).toEqual({
      mode: 'manifest-only',
      window: null,
      tail: 'full',
    });
  });

  it('stays unambiguous with hyphenated batch ids and collection names', () => {
    const id = chunkRunId(
      'app-archive-full-20261013T020304Z',
      'audit-log-v2',
      'full-collection',
      null,
      'rest'
    );

    expect(parseChunkRunId(id, 'app-archive-full-20261013T020304Z', 'audit-log-v2')?.tail).toBe(
      'rest'
    );

    expect(parseChunkRunId(id, 'app-archive-full', 'audit-log-v2')).toBeNull();
    expect(parseChunkRunId(id, 'app-archive-full-20261013T020304Z', 'audit')).toBeNull();

    // A collection named like another's prefix plus a mode-looking suffix does not match that other
    // collection.
    const tricky = chunkRunId('b', 'c-full-collection', 'full-collection', null);

    expect(parseChunkRunId(tricky, 'b', 'c')).toBeNull();
    expect(parseChunkRunId(tricky, 'b', 'c-full-collection')?.mode).toBe('full-collection');
  });

  it('accepts foreign batch ids of any shape', () => {
    expect(
      parseChunkRunId(
        'legacy.batch_01-orders-objectid-window-20250101T000000Z-20250102T000000Z',
        'legacy.batch_01',
        'orders'
      )?.window?.end.toISOString()
    ).toBe('2025-01-02T00:00:00.000Z');
  });

  it('rejects malformed tails and impossible dates', () => {
    expect(parseChunkRunId('b-c-timestamp-window-20260302T000000Z', 'b', 'c')).toBeNull();
    expect(parseChunkRunId('b-c-full-collection-other', 'b', 'c')).toBeNull();
    expect(parseChunkRunId('b-c-manifest-only-rest', 'b', 'c')).toBeNull();

    expect(
      parseChunkRunId('b-c-timestamp-window-20261399T000000Z-20261400T000000Z', 'b', 'c')
    ).toBeNull();

    expect(parseChunkRunId('other-c-full-collection-full', 'b', 'c')).toBeNull();
  });
});
