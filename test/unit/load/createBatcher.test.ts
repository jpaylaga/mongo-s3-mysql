import { describe, expect, it } from 'vitest';
import createBatcher from '#load/createBatcher';
import type { Batcher, LoadBatch } from '#types';
import { reject, row } from './fixtures.js';
import type { Reject } from './fixtures.js';

const rejectTuple = (r: Reject): string =>
  `(1,${r.lineNo},'${r.reason}','${r.text}',UTC_TIMESTAMP(3))`;

const batcher = (
  over: Partial<{ maxRows: number; maxBytes: number; maxRowBytes: number; fixedBytes: number }> = {}
): Batcher =>
  createBatcher({
    maxRows: 1000,
    maxBytes: 1_000_000,
    maxRowBytes: over.maxRowBytes ?? over.maxBytes ?? 1_000_000,
    fixedBytes: 100,
    rejectTuple,
    ...over,
  });

/** Bytes one row item adds: its tuple, the comma, and its key ledger tuple (key bytes plus 26). */
const rowBytes = (tuple: string, key: string): number =>
  Buffer.byteLength(tuple) + 1 + Buffer.byteLength(key) + 26;

const rejectBytes = (tuple: string): number => Buffer.byteLength(tuple) + 1;

describe('createBatcher', () => {
  it('drain returns null when empty; a batch that never filled drains with its last line', () => {
    const b = batcher();

    expect(b.drain()).toBeNull();
    expect(b.add(row('k1'), "('k1',1)", 1)).toBeNull();
    expect(b.add(row('k2'), "('k2',2)", 2)).toBeNull();

    const batch = b.drain();

    expect(batch).toEqual({
      rows: [row('k1'), row('k2')],
      rejects: [],
      toLine: 2,
      tuples: ["('k1',1)", "('k2',2)"],
      rejectTuples: [],
      childTuples: [new Map(), new Map()],
    });

    expect(b.drain()).toBeNull();
  });

  it('closes at maxRows: add returns the full batch and carries the new item over', () => {
    const b = batcher({ maxRows: 2 });

    expect(b.add(row('k1'), 't1', 1)).toBeNull();
    expect(b.add(row('k2'), 't2', 2)).toBeNull();

    const first = b.add(row('k3'), 't3', 3) as LoadBatch;

    expect(first.rows.map(r => r.key)).toEqual(['k1', 'k2']);
    expect(first.toLine).toBe(2);
    expect(first.tuples).toEqual(['t1', 't2']);
    expect(b.add(row('k4'), 't4', 4)).toBeNull();

    const second = b.add(row('k5'), 't5', 5) as LoadBatch;

    expect(second.rows.map(r => r.key)).toEqual(['k3', 'k4']);
    expect(second.toLine).toBe(4);
    expect(b.drain()).toMatchObject({ rows: [row('k5')], toLine: 5 });
  });

  it('rows and rejects both count toward maxRows and keep their own tuple lists', () => {
    const b = batcher({ maxRows: 3 });
    const rj = reject(2);

    expect(b.add(row('k1'), 't1', 1)).toBeNull();
    expect(b.add(rj, rejectTuple(rj), 2)).toBeNull();
    expect(b.add(row('k3'), 't3', 3)).toBeNull();

    const batch = b.add(row('k4'), 't4', 4) as LoadBatch;

    expect(batch.rows.map(r => r.key)).toEqual(['k1', 'k3']);
    expect(batch.rejects).toEqual([rj]);
    expect(batch.tuples).toEqual(['t1', 't3']);
    expect(batch.rejectTuples).toEqual([rejectTuple(rj)]);
    expect(batch.toLine).toBe(3);
  });

  it('maxRows 1 yields one item per batch', () => {
    const b = batcher({ maxRows: 1 });

    expect(b.add(row('k1'), 't1', 1)).toBeNull();
    expect(b.add(row('k2'), 't2', 2)).toMatchObject({ rows: [row('k1')], toLine: 1 });
    expect(b.add(row('k3'), 't3', 3)).toMatchObject({ rows: [row('k2')], toLine: 2 });
    expect(b.drain()).toMatchObject({ rows: [row('k3')], toLine: 3 });
  });

  it('closes on bytes: fixedBytes plus every tuple (row, comma, key ledger) fits maxBytes', () => {
    const tuple = "('k1',1)";
    const perRow = rowBytes(tuple, 'k1');
    // Exactly two rows fit; the boundary itself is allowed (<=), the third row overflows.
    const b = batcher({ fixedBytes: 100, maxBytes: 100 + 2 * perRow });

    expect(b.add(row('k1'), tuple, 1)).toBeNull();
    expect(b.add(row('k1'), tuple, 2)).toBeNull();

    const batch = b.add(row('k1'), tuple, 3) as LoadBatch;

    expect(batch.rows).toHaveLength(2);
    expect(batch.toLine).toBe(2);
    expect(b.drain()).toMatchObject({ rows: [row('k1')], toLine: 3 });

    // One byte less and only one row fits.
    const tight = batcher({ fixedBytes: 100, maxBytes: 100 + 2 * perRow - 1 });

    expect(tight.add(row('k1'), tuple, 1)).toBeNull();
    expect(tight.add(row('k1'), tuple, 2)).toMatchObject({ rows: [row('k1')], toLine: 1 });
  });

  it('a reject costs its tuple plus the comma and no key ledger bytes', () => {
    const rj = reject(1);
    const tuple = rejectTuple(rj);
    const b = batcher({ fixedBytes: 10, maxBytes: 10 + 2 * rejectBytes(tuple) });

    expect(b.add(rj, tuple, 1)).toBeNull();
    expect(b.add(rj, tuple, 2)).toBeNull();
    expect(b.add(rj, tuple, 3)).toMatchObject({ rejects: [rj, rj], toLine: 2 });

    const tight = batcher({ fixedBytes: 10, maxBytes: 10 + 2 * rejectBytes(tuple) - 1 });

    expect(tight.add(rj, tuple, 1)).toBeNull();
    expect(tight.add(rj, tuple, 2)).toMatchObject({ rejects: [rj], toLine: 1 });
  });

  it('a key with multibyte characters is budgeted by its UTF-8 bytes', () => {
    const key = 'clé-é';
    const tuple = `('${key}',1)`;
    const perRow = rowBytes(tuple, key);

    expect(perRow).toBe(tuple.length + 2 + 1 + key.length + 2 + 26);

    const b = batcher({ fixedBytes: 0, maxBytes: perRow });

    expect(b.add(row(key), tuple, 1)).toBeNull();
    expect(b.add(row(key), tuple, 2)).toMatchObject({ rows: [row(key)] });
  });

  it('a row between the batch budget and maxRowBytes closes the open batch and goes alone', () => {
    const b = batcher({ fixedBytes: 100, maxBytes: 150, maxRowBytes: 1000 });
    const small = "('k1',1)";

    expect(b.add(row('k1'), small, 1)).toBeNull();

    const bigTuple = `('k2','${'x'.repeat(180)}')`;
    const big = row('k2', [1, 'x'.repeat(180)]);

    expect(rowBytes(bigTuple, 'k2')).toBeGreaterThan(150);
    expect(rowBytes(bigTuple, 'k2') + 100).toBeLessThan(1000);
    // The big row does not fit beside k1, so k1 flushes; the big row is kept as a row, not a
    // reject.
    expect(b.add(big, bigTuple, 2)).toMatchObject({ rows: [row('k1')], rejects: [], toLine: 1 });

    // The next row cannot join the oversized batch either, so the big row comes back alone.
    const alone = b.add(row('k3'), small, 3) as LoadBatch;

    expect(alone).toEqual({
      rows: [big],
      rejects: [],
      toLine: 2,
      tuples: [bigTuple],
      rejectTuples: [],
      childTuples: [new Map()],
    });

    expect(b.drain()).toMatchObject({ rows: [row('k3')], toLine: 3 });

    // Beyond maxRowBytes the row cannot be sent in one packet at all and is rejected.
    const huge = row('k4', [1, 'x'.repeat(2000)]);
    const hugeTuple = `('k4','${'x'.repeat(2000)}')`;

    expect(b.add(huge, hugeTuple, 4)).toBeNull();

    expect(b.drain()).toMatchObject({
      rows: [],
      rejects: [
        {
          kind: 'reject',
          lineNo: 4,
          reason: 'row larger than max_allowed_packet',
          text: hugeTuple,
        },
      ],
      toLine: 4,
    });
  });

  it('a row over the budget becomes a rejectTuple reject when maxRowBytes is the budget', () => {
    const b = batcher({ fixedBytes: 100, maxBytes: 150 });
    const big = row('k1', [1, 'x'.repeat(200)]);
    const tuple = `('k1','${'x'.repeat(200)}')`;

    expect(b.add(big, tuple, 7)).toBeNull();

    const batch = b.drain() as LoadBatch;

    expect(batch.rows).toEqual([]);

    expect(batch.rejects).toEqual([
      { kind: 'reject', lineNo: 7, reason: 'row larger than max_allowed_packet', text: tuple },
    ]);

    expect(batch.rejectTuples).toEqual([rejectTuple(batch.rejects[0] as Reject)]);
    expect(batch.toLine).toBe(7);
  });

  it('an oversized row counts as an item and shares the batch if its clipped reject fits', () => {
    // The reject keeps at most 16,384 bytes of the tuple, so a 30,000-byte row fits a 20,000-byte
    // budget only as a reject.
    const small = "('k1',1)";
    const b = batcher({ fixedBytes: 0, maxBytes: 20_000, maxRows: 2 });

    expect(b.add(row('k1'), small, 1)).toBeNull();

    const bigTuple = `('k2','${'y'.repeat(30_000)}')`;

    expect(b.add(row('k2', [1, 'y'.repeat(30_000)]), bigTuple, 2)).toBeNull();

    const batch = b.add(row('k3'), small, 3) as LoadBatch;

    expect(batch.rows.map(r => r.key)).toEqual(['k1']);
    expect(batch.rejects.map(r => r.lineNo)).toEqual([2]);
    expect(Buffer.byteLength(batch.rejectTuples[0] as string, 'utf8')).toBeLessThan(20_000);
    expect(batch.toLine).toBe(2);
  });

  it('an oversized row reject keeps the first 16,384 UTF-8 bytes at a character boundary', () => {
    const b = batcher({ fixedBytes: 0, maxBytes: 1000 });
    const tuple = `${'a'.repeat(16_382)}é${'b'.repeat(100)}`;

    b.add(row('k1', [tuple]), tuple, 1);

    const text = (b.drain() as LoadBatch).rejects[0]?.text as string;

    expect(Buffer.byteLength(text, 'utf8')).toBe(16_384);
    expect(text).toBe(`${'a'.repeat(16_382)}é`);

    const odd = batcher({ fixedBytes: 0, maxBytes: 1000 });
    const tuple2 = `${'a'.repeat(16_383)}é${'b'.repeat(100)}`;

    odd.add(row('k1', [tuple2]), tuple2, 1);
    expect((odd.drain() as LoadBatch).rejects[0]?.text).toBe('a'.repeat(16_383));
  });

  it('an oversized reject tuple (at most a line_text plus reason) is accepted as is', () => {
    const rj = reject(1, 'r', 'z'.repeat(300));
    const tuple = rejectTuple(rj);
    const b = batcher({ fixedBytes: 100, maxBytes: 150 });

    expect(b.add(rj, tuple, 1)).toBeNull();
    expect(b.drain()).toMatchObject({ rejects: [rj], rejectTuples: [tuple] });
  });

  it('child tuples count toward the batch budget and ride with their row', () => {
    const tuple = "('k1',1)";
    const child = `('k1',0,'${'x'.repeat(100)}')`;
    const children = new Map([['items', [child, child]]]);
    const perRow = rowBytes(tuple, 'k1') + 2 * (Buffer.byteLength(child) + 1);
    const b = batcher({ fixedBytes: 100, maxBytes: 100 + 2 * perRow });

    expect(b.add(row('k1'), tuple, 1, children)).toBeNull();
    expect(b.add(row('k1'), tuple, 2, children)).toBeNull();

    const batch = b.add(row('k1'), tuple, 3, children) as LoadBatch;

    expect(batch.rows).toHaveLength(2);
    expect(batch.childTuples).toEqual([children, children]);

    // Without the child bytes the same three rows would have fit one batch.
    const plain = batcher({ fixedBytes: 100, maxBytes: 100 + 2 * perRow });

    expect(plain.add(row('k1'), tuple, 1)).toBeNull();
    expect(plain.add(row('k1'), tuple, 2)).toBeNull();
    expect(plain.add(row('k1'), tuple, 3)).toBeNull();
  });

  it('one child tuple larger than the packet rejects its row, like an oversized parent row', () => {
    const b = batcher({ fixedBytes: 100, maxBytes: 150, maxRowBytes: 1000 });
    const tuple = "('k1',1)";
    const huge = new Map([['items', [`('k1',0,'${'x'.repeat(2000)}')`]]]);

    expect(b.add(row('k1'), tuple, 4, huge)).toBeNull();

    expect(b.drain()).toMatchObject({
      rows: [],
      rejects: [
        {
          kind: 'reject',
          lineNo: 4,
          reason: 'child row larger than max_allowed_packet',
          text: tuple,
        },
      ],
      toLine: 4,
    });

    // Several child tuples that only add up past the packet are split across statements by
    // writeBatch, so they stay rows.
    const many = new Map([
      ['items', Array.from({ length: 5 }, () => `('k1',0,'${'x'.repeat(300)}')`)],
    ]);

    const ok = batcher({ fixedBytes: 100, maxBytes: 150, maxRowBytes: 1000 });

    expect(ok.add(row('k1'), tuple, 5, many)).toBeNull();
    expect(ok.drain()).toMatchObject({ rows: [row('k1')], rejects: [] });
  });

  it('after a flush the byte and row counters restart from fixedBytes and zero', () => {
    const tuple = "('k1',1)";
    const perRow = rowBytes(tuple, 'k1');
    const b = batcher({ fixedBytes: 5, maxBytes: 5 + perRow, maxRows: 10 });

    expect(b.add(row('k1'), tuple, 1)).toBeNull();
    expect(b.add(row('k1'), tuple, 2)).toMatchObject({ toLine: 1 });
    expect(b.add(row('k1'), tuple, 3)).toMatchObject({ toLine: 2 });
    expect(b.drain()).toMatchObject({ toLine: 3, rows: [row('k1')] });
  });
});
