import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import docToLine from '../../../src/ejson/docToLine.js';

describe('docToLine', () => {
  it('writes canonical Extended JSON keeping Int32, Double, Long and Decimal128 wrappers', () => {
    const line = docToLine({
      _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'), i: new Int32(5), d: new Double(5), l: Long.fromString('9007199254740993'),
      m: Decimal128.fromString('8.47723912345'), t: new Date('2026-03-02T00:00:01.527Z'), b: new Binary(Buffer.from('ab'), 0), s: 'x', n: null, o: { a: [1] },
    });
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      _id: { $oid: '65f1c0a1b2c3d4e5f6a7b8c9' }, i: { $numberInt: '5' }, d: { $numberDouble: '5.0' }, l: { $numberLong: '9007199254740993' },
      m: { $numberDecimal: '8.47723912345' }, t: { $date: { $numberLong: '1772409601527' } }, b: { $binary: { base64: 'YWI=', subType: '00' } },
      s: 'x', n: null, o: { a: [{ $numberInt: '1' }] },
    });
  });

  it('fails loudly on a date outside the JavaScript range instead of archiving NaN', () => {
    // What the driver hands back for a BSON date beyond +/-8.64e15 ms (Java's Long.MAX_VALUE "never" sentinel).
    expect(() => docToLine({ _id: new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9'), expires: new Date(NaN) }))
      .toThrow(expect.objectContaining({ msmCode: 'parse', message: expect.stringMatching(/^\{"_id":\{"\$oid":"65f1c0a1b2c3d4e5f6a7b8c9"\}\}: a date is outside the JavaScript range/) }));
    // The marker inside a string value is escaped and must not trip the check.
    expect(JSON.parse(docToLine({ s: '{"$date":{"$numberLong":"NaN"}}' }))).toEqual({ s: '{"$date":{"$numberLong":"NaN"}}' });
  });

  it('is one compact line per document', () => {
    expect(docToLine({ a: 1 })).toBe('{"a":{"$numberInt":"1"}}');
  });
});
