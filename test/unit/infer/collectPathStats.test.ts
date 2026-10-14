import { describe, expect, it } from 'vitest';
import collectPathStats from '#infer/collectPathStats';
import type { JsonObject, PathStats } from '#types';
import { fixtureDocs } from './seedChunks.js';

const statFor = (stats: PathStats[], path: string): PathStats => {
  const s = stats.find(x => x.path === path);

  if (s === undefined) throw new Error(`no stats for ${path}`);

  return s;
};

describe('collectPathStats', () => {
  it('keeps first-seen order and counts presence, nulls and types per field', () => {
    const docs: JsonObject[] = [
      { _id: { $oid: 'a'.repeat(24) }, b: 'x', a: null },
      { _id: { $oid: 'b'.repeat(24) }, a: { $numberInt: '1' }, c: true },
      { b: 'yy' },
    ];

    const stats = collectPathStats(docs);

    expect(stats.map(s => s.path)).toEqual(['_id', 'b', 'a', 'c']);
    expect(statFor(stats, 'a')).toMatchObject({ present: 2, nulls: 1, types: { int: 1 } });

    expect(statFor(stats, 'b')).toMatchObject({
      present: 2,
      nulls: 0,
      types: { string: 2 },
      maxChars: 2,
      maxBytes: 2,
    });

    expect(statFor(stats, 'c')).toMatchObject({ present: 1, types: { bool: 1 } });
    expect(statFor(stats, '_id')).toMatchObject({ present: 2, types: { objectId: 2 } });
  });

  it('names wrapper types from the raw tree and bare numbers by their range', () => {
    const stats = collectPathStats([
      {
        oid: { $oid: 'c'.repeat(24) },
        i: { $numberInt: '7' },
        l: { $numberLong: '7' },
        d: { $numberDouble: '1.5' },
        m: { $numberDecimal: '1.50' },
        t: { $date: { $numberLong: '0' } },
        bin: { $binary: { base64: '', subType: '00' } },
        re: { $regularExpression: { pattern: 'a', options: '' } },
        bare: 3,
        big: 3_000_000_000,
        frac: 0.5,
        arr: [1],
        obj: { k: 1 },
      },
    ]);

    const type = (path: string) => Object.keys(statFor(stats, path).types);

    expect(type('oid')).toEqual(['objectId']);
    expect(type('i')).toEqual(['int']);
    expect(type('l')).toEqual(['long']);
    expect(type('d')).toEqual(['double']);
    expect(type('m')).toEqual(['decimal']);
    expect(type('t')).toEqual(['date']);
    expect(type('bin')).toEqual(['binary']);
    expect(type('re')).toEqual(['regularExpression']);
    expect(type('bare')).toEqual(['int']);
    expect(type('big')).toEqual(['long']);
    expect(type('frac')).toEqual(['double']);
    expect(type('arr')).toEqual(['array']);
    expect(type('obj')).toEqual(['object']);
  });

  it('measures strings in code points and UTF-8 bytes', () => {
    const stats = collectPathStats([{ s: 'héllo' }, { s: '😀' }]);

    expect(statFor(stats, 's')).toMatchObject({ maxChars: 5, maxBytes: 6 });
  });

  it('counts integer digits and scale, with exponents applied and fraction zeros kept', () => {
    const stats = collectPathStats([
      { n: { $numberDecimal: '2222.50' } },
      { n: { $numberDecimal: '10.00' } },
      { n: { $numberInt: '111' } },
      { e: { $numberDecimal: '1.2E+3' } },
      { e: { $numberDecimal: '1.5E-3' } },
      { z: { $numberDecimal: '0.25' } },
      { nan: { $numberDecimal: 'NaN' } },
      { d: { $numberDouble: '5.0' } },
      { bare: 12.345 },
    ]);

    expect(statFor(stats, 'n')).toMatchObject({ maxIntDigits: 4, maxScale: 2 });
    expect(statFor(stats, 'e')).toMatchObject({ maxIntDigits: 4, maxScale: 4 });
    expect(statFor(stats, 'z')).toMatchObject({ maxIntDigits: 0, maxScale: 2 });

    expect(statFor(stats, 'nan')).toMatchObject({
      maxIntDigits: 0,
      maxScale: 0,
      types: { decimal: 1 },
    });

    expect(statFor(stats, 'd')).toMatchObject({ maxIntDigits: 1, maxScale: 1 });
    expect(statFor(stats, 'bare')).toMatchObject({ maxIntDigits: 2, maxScale: 3 });
  });

  it('a crafted $numberDecimal exponent counts as a digitless decimal, not a huge string', () => {
    // '1E+600000000' threw RangeError (invalid string length) out of the sampler before the
    // exponent guard.
    const stats = collectPathStats([
      { x: { $numberDecimal: '1E+400000000' } },
      { x: { $numberDecimal: '1E+600000000' } },
      { x: { $numberDecimal: '1E-600000000' } },
      { x: { $numberDecimal: `1E+${'9'.repeat(400)}` } },
      { x: { $numberDecimal: '1E+6176' } },
      { x: { $numberDecimal: '2.5' } },
    ]);

    // Only the legal exponent and the plain value contribute digits; the legal one pads at most
    // about 6,200 characters.
    expect(statFor(stats, 'x')).toMatchObject({
      maxIntDigits: 6177,
      maxScale: 1,
      types: { decimal: 6 },
    });
  });

  it('recognises arrays of objects, treats empty arrays as neutral, collects element stats', () => {
    const stats = collectPathStats([
      { items: [{ sku: 'a', qty: { $numberInt: '1' } }, { sku: 'b' }] },
      { items: [] },
      { items: null },
      { items: [{ sku: 'c', extra: true }] },
    ]);

    const items = statFor(stats, 'items');

    expect(items.arrayOfObjects).toBe(true);
    expect(items.elements?.map(e => e.path)).toEqual(['sku', 'qty', 'extra']);

    expect(statFor(items.elements as PathStats[], 'sku')).toMatchObject({
      present: 3,
      types: { string: 3 },
    });

    expect(statFor(items.elements as PathStats[], 'qty')).toMatchObject({ present: 1 });
  });

  it('rules a child table out once any value is not an array of plain objects', () => {
    const mixed = collectPathStats([{ a: [{ x: 1 }] }, { a: [{ $oid: 'd'.repeat(24) }] }]);

    expect(statFor(mixed, 'a')).toMatchObject({ arrayOfObjects: false, elements: null });

    const scalars = collectPathStats([{ a: [{ x: 1 }] }, { a: 'no' }, { a: [{ y: 2 }] }]);

    expect(statFor(scalars, 'a')).toMatchObject({ arrayOfObjects: false, elements: null });

    const strings = collectPathStats([{ tags: ['gift', 'repeat'] }]);

    expect(statFor(strings, 'tags')).toMatchObject({ arrayOfObjects: false, elements: null });

    const onlyEmpty = collectPathStats([{ a: [] }, { a: [] }]);

    expect(statFor(onlyEmpty, 'a')).toMatchObject({ arrayOfObjects: false, elements: null });
  });

  it('feeds element fields one at a time, so 150,000 subdocuments do not blow the stack', () => {
    const history = Array.from({ length: 150_000 }, (_, i) => ({
      t: i,
      note: i % 2 === 0 ? 'x' : null,
    }));

    const stats = collectPathStats([
      { _id: { $oid: 'a'.repeat(24) }, history },
      { _id: { $oid: 'b'.repeat(24) }, history: [{ t: 1 }] },
    ]);

    const h = statFor(stats, 'history');

    expect(h.arrayOfObjects).toBe(true);

    expect(statFor(h.elements as PathStats[], 't')).toMatchObject({
      present: 150_001,
      types: { int: 150_001 },
    });

    expect(statFor(h.elements as PathStats[], 'note')).toMatchObject({
      present: 150_000,
      nulls: 75_000,
      types: { string: 75_000 },
    });
  });

  it('stops at 32 levels of nested arrays of objects, so one deep line cannot end the run', () => {
    const deep = (depth: number): unknown =>
      depth === 0 ? { leaf: 1 } : { a: [deep(depth - 1) as JsonObject] };

    const shallow = collectPathStats([{ _id: 'x', ...(deep(10) as JsonObject) }]);
    let level = statFor(shallow, 'a');

    for (let i = 1; i < 10; i += 1) level = statFor(level.elements as PathStats[], 'a');

    expect(statFor(level.elements as PathStats[], 'leaf')).toMatchObject({ types: { int: 1 } });

    const stats = collectPathStats([{ _id: 'x', ...(deep(5000) as JsonObject) }]);
    let cursor = statFor(stats, 'a');
    let depth = 1;

    while (cursor.arrayOfObjects && cursor.elements !== null) {
      cursor = statFor(cursor.elements, 'a');
      depth += 1;
    }

    // The deepest array seen before the bound is kept as json (arrayOfObjects false), and nothing
    // below it is walked.
    expect(depth).toBe(33);
    expect(cursor).toMatchObject({ arrayOfObjects: false, elements: null, types: { array: 1 } });
  });

  it('describes the orders fixture as the golden mapping expects', async () => {
    const stats = collectPathStats(await fixtureDocs('orders'));

    expect(stats.map(s => s.path)).toEqual([
      '_id',
      'status',
      'total',
      'sequence',
      'paid',
      'createdAt',
      'customer',
      'tags',
      'items',
      'note',
    ]);

    expect(statFor(stats, '_id').types).toEqual({ objectId: 59, string: 1 });

    expect(statFor(stats, 'total')).toMatchObject({
      types: { decimal: 58, int: 2 },
      maxIntDigits: 4,
      maxScale: 2,
    });

    expect(statFor(stats, 'note')).toMatchObject({ present: 1 });
    expect(statFor(stats, 'items')).toMatchObject({ arrayOfObjects: true });
    expect(statFor(stats, 'items').elements?.map(e => e.path)).toEqual(['sku', 'qty', 'price']);
  });
});
