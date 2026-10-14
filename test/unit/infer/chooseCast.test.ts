import { describe, expect, it } from 'vitest';
import chooseCast from '../../../src/infer/chooseCast.js';
import type { PathStats } from '../../../src/types.js';

const stats = (types: Record<string, number>, patch: Partial<PathStats> = {}): PathStats => {
  const present = Object.values(types).reduce((a, b) => a + b, 0) + (patch.nulls ?? 0);
  return { path: 'f', present, nulls: 0, types, maxChars: 0, maxBytes: 0, maxIntDigits: 0, maxScale: 0, arrayOfObjects: false, elements: null, ...patch };
};
const opts = { timezone: 'UTC', sampled: 100, minPresence: 0.01 };

describe('chooseCast', () => {
  it('follows the documented table for single-type fields', () => {
    expect(chooseCast(stats({ objectId: 100 }), opts)).toMatchObject({ cast: 'objectId', sqlType: 'CHAR(24)', review: null });
    expect(chooseCast(stats({ string: 100 }, { maxChars: 9, maxBytes: 9 }), opts)).toMatchObject({ cast: 'string', sqlType: 'VARCHAR(32)' });
    expect(chooseCast(stats({ int: 100 }), opts)).toMatchObject({ cast: 'int', sqlType: 'INT' });
    expect(chooseCast(stats({ long: 100 }), opts)).toMatchObject({ cast: 'bigint', sqlType: 'BIGINT' });
    expect(chooseCast(stats({ long: 90, int: 10 }), opts)).toMatchObject({ cast: 'bigint', sqlType: 'BIGINT' });
    expect(chooseCast(stats({ double: 50, int: 30, long: 20 }), opts)).toMatchObject({ cast: 'double', sqlType: 'DOUBLE' });
    expect(chooseCast(stats({ bool: 100 }), opts)).toMatchObject({ cast: 'bool', sqlType: 'TINYINT(1)' });
    expect(chooseCast(stats({ object: 100 }), opts)).toMatchObject({ cast: 'json', sqlType: 'JSON', review: null });
    expect(chooseCast(stats({ array: 100 }), opts)).toMatchObject({ cast: 'json', sqlType: 'JSON', review: null });
    expect(chooseCast(stats({ binary: 100 }), opts)).toMatchObject({ cast: 'json', sqlType: 'JSON', review: null });
  });

  it('casts dates to DATETIME(3) and names the wall-clock zone in the note', () => {
    const choice = chooseCast(stats({ date: 100 }), { ...opts, timezone: 'Asia/Manila' });
    expect(choice).toMatchObject({ cast: 'datetime', sqlType: 'DATETIME(3)', review: null });
    expect(choice.note).toBe('date 100, wall clock in Asia/Manila');
  });

  it('sizes decimals from the digits seen and reports the evidence', () => {
    const total = chooseCast(stats({ decimal: 58, int: 2 }, { maxIntDigits: 4, maxScale: 2 }), { ...opts, sampled: 60 });
    expect(total).toEqual({ cast: 'decimal', sqlType: 'DECIMAL(14,2)', note: 'decimal 58, int 2', review: null });
    const price = chooseCast(stats({ decimal: 96 }, { maxIntDigits: 2, maxScale: 2 }), { ...opts, sampled: 96 });
    expect(price.sqlType).toBe('DECIMAL(10,2)');
    expect(chooseCast(stats({ decimal: 10, long: 5 }, { maxIntDigits: 19, maxScale: 0 }), opts).sqlType).toBe('DECIMAL(42,0)');
  });

  it('clamps the scale to 30 and the precision to 65, rounding half-up when digits are lost', () => {
    const wideScale = chooseCast(stats({ decimal: 100 }, { maxIntDigits: 3, maxScale: 34 }), opts);
    expect(wideScale).toMatchObject({ cast: 'decimal', sqlType: 'DECIMAL(40,30)', round: 'half-up' });
    expect(wideScale.review).toContain('scale clamped from 34 to 30');
    const wideInt = chooseCast(stats({ decimal: 100 }, { maxIntDigits: 60, maxScale: 10 }), opts);
    expect(wideInt).toMatchObject({ sqlType: 'DECIMAL(65,5)', round: 'half-up' });
    const exact = chooseCast(stats({ decimal: 100 }, { maxIntDigits: 65, maxScale: 0 }), opts);
    expect(exact).toMatchObject({ sqlType: 'DECIMAL(65,0)', review: null });
    expect(exact.round).toBeUndefined();
    const tooWide = chooseCast(stats({ decimal: 100 }, { maxIntDigits: 66, maxScale: 0 }), opts);
    expect(tooWide).toMatchObject({ cast: 'json', sqlType: 'JSON' });
    expect(tooWide.review).toContain('66 integer digits');
  });

  it('picks VARCHAR sizes with 1.5 x headroom, then TEXT by bytes', () => {
    const size = (maxChars: number, maxBytes = maxChars) => chooseCast(stats({ string: 1 }, { maxChars, maxBytes }), { ...opts, sampled: 1 }).sqlType;
    expect(size(21)).toBe('VARCHAR(32)');
    expect(size(22)).toBe('VARCHAR(64)');
    expect(size(170)).toBe('VARCHAR(255)');
    expect(size(171)).toBe('VARCHAR(512)');
    expect(size(682)).toBe('VARCHAR(1024)');
    expect(size(683, 683)).toBe('TEXT');
    expect(size(683, 16_000)).toBe('TEXT');
    expect(size(683, 16_001)).toBe('MEDIUMTEXT');
  });

  it('drops a field below minPresence and reports the share', () => {
    const rare = chooseCast(stats({ string: 1 }), { ...opts, sampled: 60, minPresence: 0.02 });
    expect(rare).toEqual({ cast: null, sqlType: null, note: 'string 1, missing 59', review: 'present in 1.7% of samples' });
    const kept = chooseCast(stats({ string: 2 }), { ...opts, sampled: 60, minPresence: 0.02 });
    expect(kept.cast).toBe('string');
    expect(chooseCast(stats({ string: 1 }), { ...opts, sampled: 0 }).cast).toBeNull();
  });

  it('keeps mixed and null-only fields as json with a review line', () => {
    const mixed = chooseCast(stats({ string: 70, int: 30 }), opts);
    expect(mixed).toMatchObject({ cast: 'json', sqlType: 'JSON' });
    expect(mixed.review).toBe('mixed types in the sample (string 70, int 30); kept as json');
    expect(chooseCast(stats({ decimal: 50, double: 50 }), opts).cast).toBe('json');
    expect(chooseCast(stats({ date: 50, string: 50 }), opts).cast).toBe('json');
    const nulls = chooseCast(stats({}, { nulls: 100 }), opts);
    expect(nulls).toMatchObject({ cast: 'json', sqlType: 'JSON', note: 'null 100', review: 'no non-null value in the sample' });
  });

  it('writes evidence as counts in descending order, then nulls and absences', () => {
    const choice = chooseCast(stats({ int: 10, string: 60 }, { nulls: 5 }), { ...opts, sampled: 100 });
    expect(choice.note).toBe('string 60, int 10, null 5, missing 25');
  });
});
