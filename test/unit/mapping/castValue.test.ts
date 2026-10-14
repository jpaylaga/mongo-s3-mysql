import { describe, expect, it } from 'vitest';
import castValue from '../../../src/mapping/castValue.js';
import type { CastSpec, ColumnInfo } from '../../../src/types.js';
import { col } from '../mysql/fakeTables.js';

const cast = (value: unknown, spec: CastSpec | CastSpec['cast'], target: ColumnInfo | null = null) =>
  castValue(value, typeof spec === 'string' ? { cast: spec } : spec, target);
const okValue = (value: unknown, spec: CastSpec | CastSpec['cast'], target: ColumnInfo | null = null) => {
  const r = cast(value, spec, target);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.value;
};
const reason = (value: unknown, spec: CastSpec | CastSpec['cast'], target: ColumnInfo | null = null) => {
  const r = cast(value, spec, target);
  if (r.ok) throw new Error(`expected a cast error, got value ${String(r.value)}`);
  return r.reason;
};

describe('castValue', () => {
  describe('string', () => {
    it('accepts JSON strings only and applies the live length limits', () => {
      expect(okValue('abc', 'string')).toBe('abc');
      expect(reason(5, 'string')).toMatch(/not a string: a number/);
      expect(reason({ $numberInt: '5' }, 'string')).toMatch(/not a string: a \$numberInt value/);
      expect(reason(null, 'string')).toMatch(/not a string: null/);
      const varchar = col('ip_address', 'varchar', { charLength: 45, octetLength: 180 });
      expect(okValue('a'.repeat(45), 'string', varchar)).toHaveLength(45);
      expect(reason('a'.repeat(46), 'string', varchar)).toMatch(/46 characters exceed varchar\(45\)/);
      // Code points, not UTF-16 units: 3 astral characters fit CHAR(3).
      expect(okValue('\u{1F600}\u{1F600}\u{1F600}', 'string', col('c', 'char', { charLength: 3, octetLength: 12 }))).toHaveLength(6);
      const text = col('description', 'tinytext', { charLength: 255, octetLength: 255 });
      expect(okValue('é'.repeat(127), 'string', text)).toHaveLength(127);
      expect(reason('é'.repeat(128), 'string', text)).toMatch(/256 bytes exceed tinytext \(255 bytes\)/);
      // A JSON column has no length limit, but it only takes JSON text.
      expect(okValue(JSON.stringify('x'.repeat(1000)), 'string', col('j', 'json'))).toHaveLength(1002);
    });
    it('key-string is the same cast', () => {
      expect(okValue('legacy-7', 'key-string')).toBe('legacy-7');
      expect(reason({ $oid: '69a4d3015a5a5a0001000001' }, 'key-string')).toMatch(/not a string/);
    });
  });

  describe('int and bigint', () => {
    it('reads $numberInt, $numberLong and bare integers', () => {
      expect(okValue({ $numberInt: '42' }, 'int')).toBe(42);
      expect(okValue(42, 'int')).toBe(42);
      expect(okValue({ $numberLong: '-7' }, 'int')).toBe(-7);
      expect(reason(4.5, 'int')).toMatch(/not an integer: a number/);
      expect(reason('42', 'int')).toMatch(/not an integer: a string/);
      expect(reason({ $numberDouble: '4.0' }, 'int')).toMatch(/not an integer/);
      expect(okValue({ $numberLong: '9223372036854775807' }, 'bigint')).toBe('9223372036854775807');
      expect(okValue({ $numberInt: '5' }, 'bigint')).toBe('5');
      expect(okValue(12, 'key-bigint')).toBe('12');
      expect(reason({ $numberLong: '9223372036854775807' }, 'int')).toMatch(/beyond 2\^53; use cast bigint/);
    });
    it('checks the live column range, signed and unsigned', () => {
      expect(okValue(255, 'int', col('t', 'tinyint unsigned'))).toBe(255);
      expect(reason(256, 'int', col('t', 'tinyint unsigned'))).toMatch(/256 is outside tinyint unsigned \(0\.\.255\)/);
      expect(reason(-1, 'int', col('t', 'tinyint unsigned'))).toMatch(/-1 is outside/);
      expect(okValue(-128, 'int', col('t', 'tinyint'))).toBe(-128);
      expect(reason(128, 'int', col('t', 'tinyint'))).toMatch(/outside tinyint \(-128\.\.127\)/);
      expect(reason(2147483648, 'int', col('i', 'int'))).toMatch(/outside int/);
      expect(okValue(2147483648, 'int', col('i', 'int unsigned'))).toBe(2147483648);
      expect(okValue({ $numberLong: '18446744073709551615' }, 'bigint', col('b', 'bigint unsigned'))).toBe('18446744073709551615');
      expect(reason({ $numberLong: '18446744073709551615' }, 'bigint', col('b', 'bigint'))).toMatch(/outside bigint/);
      expect(reason({ $numberLong: '-1' }, 'bigint', col('b', 'bigint unsigned'))).toMatch(/outside bigint unsigned/);
      expect(okValue(7, 'int', col('d', 'decimal', { precision: 10, scale: 0 }))).toBe(7);
    });
  });

  describe('double', () => {
    it('reads every numeric wrapper and refuses what MySQL cannot store', () => {
      expect(okValue({ $numberDouble: '5.0' }, 'double')).toBe(5);
      expect(okValue({ $numberDouble: '-1.25e3' }, 'double')).toBe(-1250);
      expect(okValue({ $numberInt: '3' }, 'double')).toBe(3);
      expect(okValue({ $numberLong: '9007199254740992' }, 'double')).toBe(9007199254740992);
      expect(reason({ $numberLong: '9007199254740993' }, 'double')).toMatch(/beyond 2\^53/);
      expect(okValue(0.1, 'double')).toBe(0.1);
      for (const bad of ['NaN', 'Infinity', '-Infinity']) expect(reason({ $numberDouble: bad }, 'double')).toMatch(new RegExp(`${bad} cannot be stored`));
      expect(reason('1.5', 'double')).toMatch(/not a number: a string/);
      expect(reason(true, 'double')).toMatch(/not a number: a boolean/);
    });
  });

  describe('decimal', () => {
    const d = (precision: number, scale: number) => col('d', 'decimal', { precision, scale });
    it('keeps $numberDecimal exact and plain', () => {
      expect(okValue({ $numberDecimal: '10.00' }, 'decimal')).toBe('10');
      expect(okValue({ $numberDecimal: '1.2E+3' }, 'decimal')).toBe('1200');
      expect(okValue({ $numberDecimal: '1.25E-3' }, 'decimal')).toBe('0.00125');
      expect(okValue({ $numberDecimal: '-0.5' }, 'decimal')).toBe('-0.5');
      expect(okValue({ $numberDecimal: '-0' }, 'decimal')).toBe('0');
      expect(okValue({ $numberDecimal: '.5' }, 'decimal')).toBe('0.5');
      expect(okValue({ $numberDecimal: '12345678901234567890.123456789' }, 'decimal')).toBe('12345678901234567890.123456789');
      for (const bad of ['NaN', 'Infinity', '-Infinity']) expect(reason({ $numberDecimal: bad }, 'decimal')).toMatch(/cannot be stored/);
    });
    it('reads integers and doubles through their shortest string', () => {
      expect(okValue({ $numberInt: '7' }, 'decimal')).toBe('7');
      expect(okValue({ $numberLong: '-9223372036854775808' }, 'decimal')).toBe('-9223372036854775808');
      expect(okValue({ $numberDouble: '0.1' }, 'decimal')).toBe('0.1');
      expect(okValue({ $numberDouble: '1e21' }, 'decimal')).toBe('1000000000000000000000');
      expect(okValue({ $numberDouble: '1.5e-7' }, 'decimal')).toBe('0.00000015');
      expect(okValue(47.5, 'decimal')).toBe('47.5');
      expect(reason({ $numberDouble: 'NaN' }, 'decimal')).toMatch(/NaN cannot be stored/);
      expect(reason('1.0', 'decimal')).toMatch(/not a decimal: a string/);
    });
    it('rejects digits beyond the column scale by default and rounds half-up on request', () => {
      expect(okValue({ $numberDecimal: '8.4700000' }, 'decimal', d(10, 2))).toBe('8.47');
      expect(reason({ $numberDecimal: '8.477' }, 'decimal', d(10, 2))).toMatch(/3 fraction digits exceed scale 2 of decimal\(10,2\)/);
      expect(reason({ $numberDouble: '0.1' }, 'decimal', d(10, 0))).toMatch(/1 fraction digits exceed scale 0/);
      expect(okValue({ $numberDecimal: '8.47723912345' }, { cast: 'decimal', round: 'half-up' }, d(10, 7))).toBe('8.4772391');
      expect(okValue({ $numberDecimal: '8.4772391500' }, { cast: 'decimal', round: 'half-up' }, d(10, 7))).toBe('8.4772392');
      expect(okValue({ $numberDecimal: '-2.5' }, { cast: 'decimal', round: 'half-up' }, d(10, 0))).toBe('-3');
      expect(okValue({ $numberDecimal: '9.995' }, { cast: 'decimal', round: 'half-up' }, d(10, 2))).toBe('10');
      expect(okValue({ $numberDecimal: '0.004' }, { cast: 'decimal', round: 'half-up' }, d(10, 2))).toBe('0');
      expect(okValue({ $numberDouble: '0.1' }, { cast: 'decimal', round: 'half-up' }, d(10, 0))).toBe('0');
    });
    it('refuses a crafted exponent or more than 65 integer digits without expanding the digits', () => {
      expect(reason({ $numberDecimal: '1E+400000000' }, 'decimal')).toMatch(/cannot be stored in MySQL/);
      expect(reason({ $numberDecimal: '1E-400000000' }, 'decimal')).toMatch(/cannot be stored in MySQL/);
      expect(reason({ $numberDecimal: '1E+6000' }, 'decimal')).toMatch(/cannot be stored in MySQL/);
      expect(reason({ $numberDecimal: `${'9'.repeat(66)}` }, 'decimal')).toMatch(/cannot be stored in MySQL/);
      expect(okValue({ $numberDecimal: `${'9'.repeat(65)}` }, 'decimal')).toBe('9'.repeat(65));
      expect(okValue({ $numberDecimal: '1.5E+64' }, 'decimal')).toBe(`15${'0'.repeat(63)}`);
      // A zero coefficient has no integer digits whatever its exponent: these are legal Decimal128 zeros.
      expect(okValue({ $numberDecimal: '0E+100' }, 'decimal')).toBe('0');
      expect(okValue({ $numberDecimal: '0E+6000' }, 'decimal')).toBe('0');
      expect(okValue({ $numberDecimal: '0.000E+70' }, 'decimal')).toBe('0');
      expect(okValue({ $numberDecimal: '-0E+100' }, 'decimal')).toBe('0');
      // Leading zeros of the coefficient do not count, significant digits still do: 0.5E+65 is 5 x 10^64 (65 digits).
      expect(okValue({ $numberDecimal: '0.5E+65' }, 'decimal')).toBe(`5${'0'.repeat(64)}`);
      expect(reason({ $numberDecimal: '0.5E+66' }, 'decimal')).toMatch(/cannot be stored in MySQL/);
    });
    it('refuses too many integer digits, after rounding', () => {
      expect(okValue({ $numberDecimal: '999.99' }, 'decimal', d(5, 2))).toBe('999.99');
      expect(reason({ $numberDecimal: '1000' }, 'decimal', d(5, 2))).toMatch(/4 integer digits exceed 3 of decimal\(5,2\)/);
      expect(reason({ $numberDecimal: '999.999' }, { cast: 'decimal', round: 'half-up' }, d(5, 2))).toMatch(/4 integer digits exceed 3/);
      expect(okValue({ $numberDecimal: '0.5' }, 'decimal', d(1, 1))).toBe('0.5');
    });
  });

  describe('bool', () => {
    it('maps booleans to 1 and 0', () => {
      expect(okValue(true, 'bool')).toBe(1);
      expect(okValue(false, 'bool')).toBe(0);
      expect(reason(1, 'bool')).toMatch(/not a boolean: a number/);
      expect(reason('true', 'bool')).toMatch(/not a boolean/);
    });
  });

  describe('datetime', () => {
    const ms = 1772409601527;
    it('reads every $date form and writes the wall clock in the mapping zone', () => {
      expect(okValue({ $date: { $numberLong: String(ms) } }, 'datetime')).toBe('2026-03-02 00:00:01');
      expect(okValue({ $date: { $numberLong: String(ms) } }, { cast: 'datetime', fsp: 3 })).toBe('2026-03-02 00:00:01.527');
      expect(okValue({ $date: { $numberLong: String(ms) } }, { cast: 'datetime', fsp: 0, timezone: 'Asia/Manila' })).toBe('2026-03-02 08:00:01');
      expect(okValue({ $date: '2026-03-02T00:00:01.527Z' }, { cast: 'datetime', fsp: 1 })).toBe('2026-03-02 00:00:01.5');
      expect(okValue({ $date: ms }, 'datetime')).toBe('2026-03-02 00:00:01');
      expect(reason({ $date: 'yesterday' }, 'datetime')).toMatch(/not a date/);
      expect(reason('2026-03-02', 'datetime')).toMatch(/not a date: a string/);
      expect(reason({ $date: { $numberLong: 'x' } }, 'datetime')).toMatch(/not a date/);
      expect(reason({ $timestamp: { t: 1, i: 1 } }, 'datetime')).toMatch(/not a date: a \$timestamp value/);
    });
    it('refuses instants outside the JavaScript range and BC dates as cast errors, never by throwing', () => {
      expect(reason({ $date: { $numberLong: '9223372036854775807' } }, 'datetime')).toMatch(/outside the JavaScript date range/);
      expect(reason({ $date: { $numberLong: '1772409601527000000' } }, 'datetime')).toMatch(/outside the JavaScript date range/);
      expect(reason({ $date: { $numberLong: '-100000000000000' } }, 'datetime')).toMatch(/outside 1000\.\.9999/);
      expect(reason({ $date: '-001200-06-01T00:00:00Z' }, 'datetime')).toMatch(/outside 1000\.\.9999/);
      expect(reason({ $date: { $numberLong: '1e20' } }, 'datetime', col('created_at', 'timestamp', { fsp: 0 }))).toMatch(/not a date/);
    });
    it('refuses years outside 1000..9999 and timestamps outside the TIMESTAMP range', () => {
      expect(reason({ $date: { $numberLong: String(Date.UTC(999, 11, 31)) } }, 'datetime')).toMatch(/outside 1000\.\.9999/);
      expect(reason({ $date: { $numberLong: String(Date.UTC(10000, 0, 1)) } }, 'datetime')).toMatch(/outside 1000\.\.9999/);
      const ts = col('created_at', 'timestamp', { fsp: 0 });
      expect(okValue({ $date: { $numberLong: String(ms) } }, 'datetime', ts)).toBe('2026-03-02 00:00:01');
      expect(reason({ $date: { $numberLong: '0' } }, 'datetime', ts)).toMatch(/outside the TIMESTAMP range/);
      expect(reason({ $date: { $numberLong: String(Date.UTC(2038, 0, 19, 0, 0, 0)) } }, 'datetime', ts)).toMatch(/outside the TIMESTAMP range/);
      expect(okValue({ $date: { $numberLong: '0' } }, 'datetime', col('created_at', 'datetime', { fsp: 0 }))).toBe('1970-01-01 00:00:00');
    });
  });

  describe('objectId and json', () => {
    it('lowercases 24-hex ObjectIds and refuses the rest', () => {
      expect(okValue({ $oid: '69A4D3015A5A5A0001000001' }, 'objectId')).toBe('69a4d3015a5a5a0001000001');
      expect(okValue({ $oid: '69a4d3015a5a5a0001000001' }, 'key-objectId')).toBe('69a4d3015a5a5a0001000001');
      expect(reason({ $oid: '69a4d3015a5a5a00010000' }, 'objectId')).toMatch(/not an ObjectId/);
      expect(reason('69a4d3015a5a5a0001000001', 'key-objectId')).toMatch(/not an ObjectId: a string/);
      expect(reason({ $numberInt: '1' }, 'key-objectId')).toMatch(/not an ObjectId/);
    });
    it('json into a non-JSON column is bound by that column, like a string', () => {
      const text = col('data', 'text', { octetLength: 20 });
      expect(okValue({ a: 1 }, 'json', text)).toBe('{"a":1}');
      expect(reason({ a: 'x'.repeat(30) }, 'json', text)).toMatch(/bytes exceed text \(20 bytes\)/);
      expect(reason({ a: 'x'.repeat(30) }, 'json', col('data', 'varchar', { charLength: 10, octetLength: 40 }))).toMatch(/characters exceed varchar\(10\)/);
      expect(okValue({ a: 'x'.repeat(70_000) }, 'json', col('data', 'json', { octetLength: null }))).toHaveLength(70_008);
    });
    it('json keeps wrappers verbatim', () => {
      const raw = { page: { $numberInt: '1' }, at: { $date: { $numberLong: '5' } }, bin: { $binary: { base64: 'AA==', subType: '00' } } };
      expect(okValue(raw, 'json')).toBe(JSON.stringify(raw));
      expect(okValue(['a', 1], 'json')).toBe('["a",1]');
      expect(okValue('s', 'json')).toBe('"s"');
      expect(okValue(null, 'json')).toBe('null');
      expect(reason(undefined, 'json')).toBe('missing');
    });
  });

describe('live column rules MySQL enforces under STRICT_ALL_TABLES', () => {
    it('refuses characters outside the column character set: utf8mb3, latin1 and ascii', () => {
      const utf8mb3 = col('c', 'varchar', { collation: 'utf8mb3_general_ci', charLength: 64, octetLength: 192 });
      expect(okValue('hi \u{FFFF}', 'string', utf8mb3)).toBe('hi \u{FFFF}');
      expect(reason('hi \u{1F600}', 'string', utf8mb3)).toBe('U+1F600 is outside the utf8mb3 character set of varchar (utf8mb3_general_ci)');
      expect(reason('x\u{1F600}', 'string', col('c', 'text', { collation: 'utf8_general_ci', octetLength: 65535 }))).toMatch(/outside the utf8 character set/);
      const latin1 = col('c', 'varchar', { collation: 'latin1_swedish_ci', charLength: 64, octetLength: 64 });
      expect(okValue('caf\u00e9 \u20ac \u2026', 'string', latin1)).toBe('caf\u00e9 \u20ac \u2026');
      expect(reason('\u4e2d\u6587', 'string', latin1)).toBe('U+4E2D is outside the latin1 character set of varchar (latin1_swedish_ci)');
      const ascii = col('c', 'char', { collation: 'ascii_bin', charLength: 8, octetLength: 8 });
      expect(okValue('abc', 'string', ascii)).toBe('abc');
      expect(reason('caf\u00e9', 'string', ascii)).toMatch(/U\+00E9 is outside the ascii character set/);
      expect(reason('\u{1F600}', 'string', col('c', 'varchar', { collation: 'ucs2_general_ci', charLength: 8, octetLength: 16 }))).toMatch(/U\+1F600 is outside the ucs2 character set/);
      // utf8mb4 and binary columns hold everything; json into a text column is checked the same way.
      expect(okValue('\u{1F600}', 'string', col('c', 'varchar', { collation: 'utf8mb4_0900_ai_ci', charLength: 8, octetLength: 32 }))).toBe('\u{1F600}');
      expect(okValue('\u{1F600}', 'string', col('c', 'varbinary', { collation: 'binary', charLength: 8, octetLength: 8 }))).toBe('\u{1F600}');
      expect(reason({ a: '\u{1F600}' }, 'json', col('c', 'text', { collation: 'utf8mb3_general_ci', octetLength: 65535 }))).toMatch(/outside the utf8mb3 character set/);
    });
    it('checks ENUM and SET membership, case-insensitively unless the collation is binary or case-sensitive', () => {
      const status = col('status', 'enum', { collation: 'utf8mb4_0900_ai_ci', charLength: 7, octetLength: 28, members: ['open', 'paid', 'pending'] });
      expect(okValue('pending', 'string', status)).toBe('pending');
      expect(okValue('Paid', 'string', status)).toBe('Paid');
      expect(reason('shipped', 'string', status)).toBe('"shipped" is not a member of enum(3 values)');
      const strict = col('status', 'enum', { collation: 'utf8mb4_0900_bin', charLength: 4, octetLength: 16, members: ['open', 'paid'] });
      expect(reason('Paid', 'string', strict)).toMatch(/"Paid" is not a member/);
      expect(reason('Paid', 'string', col('status', 'enum', { collation: 'latin1_general_cs', charLength: 4, octetLength: 4, members: ['open', 'paid'] }))).toMatch(/"Paid" is not a member/);
      expect(reason('Paid', 'string', col('status', 'enum', { collation: 'utf8mb4_0900_as_cs', charLength: 4, octetLength: 16, members: ['open', 'paid'] }))).toMatch(/"Paid" is not a member/);
      expect(okValue('paid', 'string', col('status', 'enum', { collation: 'utf8mb4_0900_as_cs', charLength: 4, octetLength: 16, members: ['open', 'paid'] }))).toBe('paid');
      const flags = col('flags', 'set', { collation: 'utf8mb4_0900_ai_ci', charLength: 3, octetLength: 12, members: ['a', 'b'] });
      expect(okValue('a,b', 'string', flags)).toBe('a,b');
      expect(okValue('', 'string', flags)).toBe('');
      expect(reason('a,c', 'string', flags)).toBe('"c" is not a member of set(2 values)');
    });
    it('bounds integers and doubles by FLOAT, DECIMAL(p,s) and the integer ranges', () => {
      const float = col('f', 'float', { precision: 12, scale: null });
      expect(okValue(3.4e38, 'double', float)).toBe(3.4e38);
      expect(reason(1e300, 'double', float)).toMatch(/1e\+300 is outside FLOAT/);
      const money = col('m', 'decimal', { precision: 5, scale: 2 });
      expect(okValue(999, 'int', money)).toBe(999);
      expect(reason(100000, 'int', money)).toBe('6 integer digits exceed 3 of decimal(5,2)');
      expect(reason({ $numberLong: '1000' }, 'bigint', money)).toBe('4 integer digits exceed 3 of decimal(5,2)');
      expect(okValue(999.99, 'double', money)).toBe(999.99);
      expect(reason(1234.5, 'double', money)).toBe('4 integer digits exceed 3 of decimal(5,2)');
      // A double into an integer column is rounded by MySQL, so the rounded value must fit.
      const tiny = col('t', 'tinyint', { precision: 3, scale: 0 });
      expect(okValue(127.4, 'double', tiny)).toBe(127.4);
      expect(reason(127.6, 'double', tiny)).toMatch(/128 is outside tinyint/);
      expect(reason(-129, 'double', col('t', 'tinyint unsigned'))).toMatch(/-129 is outside tinyint unsigned/);
      // MySQL rounds half away from zero: -128.5 becomes -129, not Math.round's -128.
      expect(reason(-128.5, 'double', col('t', 'tinyint', { precision: 3, scale: 0 }))).toMatch(/-129 is outside tinyint/);
    });
    it('applies FLOAT(M,D) and DOUBLE(M,D) of older schemas to every numeric cast', () => {
      const legacy = col('amount', 'double', { precision: 8, scale: 2 });
      expect(okValue(999999.99, 'double', legacy)).toBe(999999.99);
      expect(reason(1000000, 'double', legacy)).toBe('7 integer digits exceed 6 of double(8,2)');
      expect(reason(1000000, 'int', legacy)).toBe('7 integer digits exceed 6 of double(8,2)');
      expect(reason({ $numberLong: '1000000' }, 'bigint', legacy)).toBe('7 integer digits exceed 6 of double(8,2)');
      expect(reason({ $numberDecimal: '1000000' }, 'decimal', legacy)).toBe('7 integer digits exceed 6 of double(8,2)');
      expect(reason(1e300, 'double', legacy)).toBe('more than 65 integer digits exceed 6 of double(8,2)');
      const f = col('ratio', 'float', { precision: 7, scale: 2 });
      expect(reason(100000, 'double', f)).toBe('6 integer digits exceed 5 of float(7,2)');
      expect(reason(100000, 'int', f)).toBe('6 integer digits exceed 5 of float(7,2)');
      // The value is rounded at D before its integer digits are counted, as MySQL does.
      expect(reason(99999.996, 'double', f)).toBe('6 integer digits exceed 5 of float(7,2)');
      expect(okValue(99999.994, 'double', f)).toBe(99999.994);
      // A FLOAT or DOUBLE without (M,D) has a null scale and only FLOAT's own range applies; extra fraction digits are fine.
      expect(okValue({ $numberDecimal: '1.23456' }, 'decimal', col('f', 'float', { precision: 12, scale: null }))).toBe('1.23456');
      expect(okValue(12345678.9, 'double', col('d', 'double', { precision: 22, scale: null }))).toBe(12345678.9);
    });
    it('refuses negative values for UNSIGNED DECIMAL, FLOAT and DOUBLE', () => {
      const money = col('m', 'decimal unsigned', { precision: 5, scale: 2 });
      expect(reason(-1, 'int', money)).toBe('a negative value is outside decimal unsigned');
      expect(reason({ $numberLong: '-1' }, 'bigint', money)).toBe('a negative value is outside decimal unsigned');
      expect(reason({ $numberDecimal: '-1' }, 'decimal', money)).toBe('a negative value is outside decimal unsigned');
      expect(reason(-0.5, 'double', money)).toBe('a negative value is outside decimal unsigned');
      expect(okValue(0, 'int', money)).toBe(0);
      expect(okValue({ $numberDecimal: '-0.00' }, 'decimal', money)).toBe('0');
      expect(reason(-1, 'double', col('d', 'double unsigned'))).toBe('a negative value is outside double unsigned');
      expect(reason(-1, 'double', col('f', 'float unsigned'))).toBe('a negative value is outside float unsigned');
      expect(okValue(-0, 'double', col('d', 'double unsigned'))).toBe(-0);
    });
    it('rounds a double at the DECIMAL scale before counting integer digits, and uses FLT_MAX exactly', () => {
      const money = col('m', 'decimal', { precision: 5, scale: 2 });
      expect(reason(999.996, 'double', money)).toBe('4 integer digits exceed 3 of decimal(5,2)');
      expect(okValue(999.994, 'double', money)).toBe(999.994);
      expect(reason(-999.995, 'double', money)).toBe('4 integer digits exceed 3 of decimal(5,2)');
      const float = col('f', 'float', { precision: 12, scale: null });
      expect(okValue(3.4028234663852886e38, 'double', float)).toBe(3.4028234663852886e38);
      expect(reason(3.4028235e38, 'double', float)).toMatch(/is outside FLOAT/);
      expect(reason({ $numberDecimal: '1E+40' }, 'decimal', float)).toMatch(/is outside FLOAT/);
      expect(reason({ $numberLong: '340282350000000000000000000000000000000' }, 'bigint', float)).toMatch(/is outside FLOAT/);
    });
    it('bounds strings in VARBINARY and BLOB columns by their byte length', () => {
      const bin = col('b', 'varbinary', { collation: 'binary', charLength: 4, octetLength: 4 });
      expect(okValue('abcd', 'string', bin)).toBe('abcd');
      expect(reason('\u00e9\u00e9\u00e9', 'string', bin)).toBe('6 bytes exceed varbinary (4 bytes)');
      expect(reason({ x: 'y'.repeat(300) }, 'json', col('b', 'tinyblob', { collation: 'binary', charLength: 255, octetLength: 255 }))).toMatch(/bytes exceed tinyblob \(255 bytes\)/);
    });
    it('refuses a numeric $date that is not an integer millisecond count, which would build an invalid DATETIME literal', () => {
      const datetime = col('d', 'datetime', { fsp: 3 });
      expect(okValue({ $date: 1500 }, { cast: 'datetime', fsp: 3 }, datetime)).toBe('1970-01-01 00:00:01.500');
      expect(reason({ $date: 1.5 }, { cast: 'datetime', fsp: 3 }, datetime)).toBe('not a date: 1.5 is not an integer millisecond count');
      expect(reason({ $date: -0.5 }, { cast: 'datetime', fsp: 3 }, datetime)).toMatch(/not an integer millisecond count/);
    });
    it('a decimal into an integer column is rounded like MySQL does and must fit the range, signed or unsigned', () => {
      expect(okValue({ $numberDecimal: '127' }, 'decimal', col('t', 'tinyint'))).toBe('127');
      expect(reason({ $numberDecimal: '300' }, 'decimal', col('t', 'tinyint'))).toBe('300 is outside tinyint (-128..127)');
      expect(reason({ $numberDecimal: '127.5' }, 'decimal', col('t', 'tinyint'))).toBe('128 is outside tinyint (-128..127)');
      expect(okValue({ $numberDecimal: '127.4' }, 'decimal', col('t', 'tinyint'))).toBe('127.4');
      expect(reason({ $numberDecimal: '-5' }, 'decimal', col('i', 'int unsigned'))).toBe('-5 is outside int unsigned (0..4294967295)');
      expect(reason({ $numberDecimal: '99999999999' }, 'decimal', col('i', 'int'))).toMatch(/99999999999 is outside int/);
      expect(okValue({ $numberDecimal: '18446744073709551615' }, 'decimal', col('b', 'bigint unsigned'))).toBe('18446744073709551615');
      expect(reason({ $numberDecimal: '18446744073709551616' }, 'decimal', col('b', 'bigint unsigned'))).toMatch(/outside bigint unsigned/);
      expect(reason({ $numberDecimal: '-0.5' }, 'decimal', col('b', 'bigint unsigned'))).toMatch(/-1 is outside bigint unsigned/);
    });
  });

  describe('relaxed lines and foreign payloads', () => {
    it('refuses a bare integer beyond 2^53, which JSON.parse already rounded, for int, bigint, the key and decimal', () => {
      const a = JSON.parse('{"_id": 1234567890123456789}') as { _id: number };
      const b = JSON.parse('{"_id": 1234567890123456790}') as { _id: number };
      expect(a._id).toBe(b._id);
      expect(reason(a._id, 'key-bigint')).toBe('bare integer beyond 2^53 in a relaxed line; precision already lost');
      expect(reason(a._id, 'bigint')).toMatch(/precision already lost/);
      expect(reason(a._id, 'int')).toMatch(/precision already lost/);
      expect(reason(a._id, 'decimal')).toMatch(/precision already lost/);
      expect(okValue(9007199254740991, 'key-bigint')).toBe('9007199254740991');
      expect(okValue({ $numberLong: '1234567890123456789' }, 'key-bigint')).toBe('1234567890123456789');
    });
    it('reads only canonical $numberDouble payloads: no empty text, no hex, octal or binary literals', () => {
      expect(reason({ $numberDouble: '' }, 'double')).toBe('not a number: $numberDouble ""');
      expect(reason({ $numberDouble: ' ' }, 'double')).toMatch(/not a number/);
      expect(reason({ $numberDouble: '0x10' }, 'double')).toMatch(/not a number: \$numberDouble "0x10"/);
      expect(reason({ $numberDouble: '0b1' }, 'double')).toMatch(/not a number/);
      expect(reason({ $numberDouble: '' }, 'decimal')).toMatch(/not a number/);
      expect(reason({ $numberDouble: '0x10' }, 'decimal')).toMatch(/not a number/);
      expect(okValue({ $numberDouble: '.5' }, 'double')).toBe(0.5);
      expect(okValue({ $numberDouble: '1E3' }, 'double')).toBe(1000);
      expect(reason({ $numberDouble: 'NaN' }, 'double')).toMatch(/NaN cannot be stored/);
    });
    it('reads a string $date only with an offset, so the loader host time zone never decides the instant', () => {
      expect(okValue({ $date: '2017-03-16T09:35:07.462Z' }, 'datetime')).toBe('2017-03-16 09:35:07');
      expect(okValue({ $date: '2017-03-16T09:35:07.462+08:00' }, 'datetime')).toBe('2017-03-16 01:35:07');
      expect(okValue({ $date: '2017-03-16T09:35+0800' }, 'datetime')).toBe('2017-03-16 01:35:00');
      expect(reason({ $date: '2017-03-16T09:35:07.462' }, 'datetime')).toBe('not a date: "2017-03-16T09:35:07.462" is not an ISO 8601 instant with an offset');
      expect(reason({ $date: 'March 16, 2017' }, 'datetime')).toMatch(/not an ISO 8601 instant with an offset/);
      expect(reason({ $date: '2017-03-16' }, 'datetime')).toMatch(/not an ISO 8601 instant with an offset/);
    });
  });

  describe('a live column of another type family', () => {
    it('bounds every cast by a text column, ObjectIds and numbers included', () => {
      expect(reason({ $oid: '69a4d3015a5a5a0001000001' }, 'objectId', col('o', 'char', { charLength: 12, octetLength: 48 }))).toBe('24 characters exceed char(12)');
      expect(reason({ $oid: '69a4d3015a5a5a0001000001' }, 'key-objectId', col('o', 'binary', { collation: 'binary', charLength: 12, octetLength: 12 }))).toBe('24 bytes exceed binary (12 bytes)');
      expect(okValue({ $oid: '69a4d3015a5a5a0001000001' }, 'objectId', col('o', 'char', { charLength: 24, octetLength: 96 }))).toBe('69a4d3015a5a5a0001000001');
      expect(reason(123456, 'int', col('v', 'varchar', { charLength: 5, octetLength: 20 }))).toBe('6 characters exceed varchar(5)');
      expect(okValue(12345, 'int', col('v', 'varchar', { charLength: 5, octetLength: 20 }))).toBe(12345);
      expect(reason({ $numberLong: '1234567' }, 'bigint', col('v', 'varchar', { charLength: 5, octetLength: 20 }))).toMatch(/7 characters exceed/);
      expect(reason(1.25, 'double', col('v', 'varchar', { charLength: 3, octetLength: 12 }))).toMatch(/4 characters exceed/);
      expect(reason({ $numberDecimal: '12.50' }, 'decimal', col('v', 'char', { charLength: 3, octetLength: 12 }))).toMatch(/4 characters exceed/);
      expect(okValue(true, 'bool', col('v', 'varchar', { charLength: 1, octetLength: 4 }))).toBe(1);
      expect(reason({ $date: 1500 }, { cast: 'datetime', fsp: 3 }, col('v', 'varchar', { charLength: 19, octetLength: 76 }))).toMatch(/23 characters exceed varchar\(19\)/);
    });
    it('a string into a numeric column must be a whole decimal literal that fits', () => {
      const int = col('n', 'int');
      expect(okValue('42', 'string', int)).toBe('42');
      expect(okValue(' 42 ', 'string', int)).toBe(' 42 ');
      expect(okValue('12.5', 'string', int)).toBe('12.5');
      expect(reason('', 'string', int)).toBe('"" is not a number for int');
      expect(reason('N/A', 'string', int)).toBe('"N/A" is not a number for int');
      expect(reason('12abc', 'string', int)).toMatch(/is not a number for int/);
      expect(reason('2147483648', 'string', int)).toBe('2147483648 is outside int (-2147483648..2147483647)');
      expect(reason('127.5', 'string', col('t', 'tinyint'))).toBe('128 is outside tinyint (-128..127)');
      expect(reason('-1', 'string', col('u', 'int unsigned'))).toMatch(/-1 is outside int unsigned/);
      const money = col('m', 'decimal', { precision: 5, scale: 2 });
      expect(okValue('999.99', 'string', money)).toBe('999.99');
      expect(reason('1000', 'string', money)).toBe('4 integer digits exceed 3 of decimal(5,2)');
      expect(reason('-1', 'string', col('m', 'decimal unsigned', { precision: 5, scale: 2 }))).toBe('a negative value is outside decimal unsigned');
      expect(reason('1e40', 'string', col('f', 'float', { precision: 12, scale: null }))).toMatch(/is outside FLOAT/);
      expect(okValue('1.5', 'string', col('d', 'double', { precision: 22, scale: null }))).toBe('1.5');
      expect(reason({ a: 1 }, 'json', int)).toMatch(/is not a number for int/);
      expect(okValue(5, 'json', int)).toBe('5');
    });
    it('a string into a JSON column must be valid JSON; a date or ObjectId text never is', () => {
      const json = col('j', 'json');
      expect(okValue('{"a":1}', 'string', json)).toBe('{"a":1}');
      expect(okValue('"text"', 'string', json)).toBe('"text"');
      expect(reason('plain text', 'string', json)).toBe('"plain text" is not valid JSON for json');
      expect(reason({ $oid: '69a4d3015a5a5a0001000001' }, 'objectId', json)).toMatch(/is not valid JSON for json/);
      expect(reason({ $date: 1500 }, 'datetime', json)).toMatch(/is not valid JSON for json/);
      expect(okValue({ a: 1 }, 'json', json)).toBe('{"a":1}');
    });
    it('a number into a JSON column is sent as its text: mysql2 writes a number unquoted and MySQL refuses that (error 3140)', () => {
      const json = col('j', 'json');
      expect(okValue(5, 'int', json)).toBe('5');
      expect(okValue({ $numberDouble: '1.5' }, 'double', json)).toBe('1.5');
      expect(okValue(true, 'bool', json)).toBe('1');
      expect(okValue(false, 'bool', json)).toBe('0');
      expect(okValue({ $numberLong: '9007199254740993' }, 'bigint', json)).toBe('9007199254740993');
      expect(okValue({ $numberDecimal: '1.2E+3' }, 'decimal', json)).toBe('1200');
      // Only a JSON column rewrites the value; the number stays a number elsewhere.
      expect(okValue(5, 'int', col('n', 'int'))).toBe(5);
      expect(okValue(true, 'bool', col('b', 'tinyint'))).toBe(1);
    });
    it('whitespace around a number in text follows MySQL: trailing is skipped, leading only spaces and tabs before an integer column', () => {
      const int = col('n', 'int');
      expect(okValue('\t12', 'string', int)).toBe('\t12');
      expect(okValue('12\n', 'string', int)).toBe('12\n');
      expect(okValue(' 12 \r\n', 'string', int)).toBe(' 12 \r\n');
      expect(reason('\n12', 'string', int)).toBe('"\\n12" is not a number for int');
      expect(reason(' 12', 'string', int)).toMatch(/is not a number for int/);
      // DECIMAL, FLOAT and DOUBLE skip any leading whitespace.
      expect(okValue('\n12', 'string', col('m', 'decimal', { precision: 5, scale: 2 }))).toBe('\n12');
      expect(okValue('\n12', 'string', col('d', 'double', { precision: 22, scale: null }))).toBe('\n12');
    });
    it('a number into ENUM is a 1-based member index and into SET a bit mask, as MySQL reads it; anything else is a cast error', () => {
      const status = col('status', 'enum', { collation: 'utf8mb4_0900_ai_ci', charLength: 7, octetLength: 28, members: ['open', 'paid', 'pending'] });
      expect(okValue(3, 'int', status)).toBe(3);
      expect(okValue(true, 'bool', status)).toBe(1);
      expect(reason(4, 'int', status)).toBe('"4" is not a member of enum(3 values); MySQL reads a number into ENUM as the 1-based member index');
      expect(reason(0, 'int', status)).toMatch(/"0" is not a member of enum/);
      expect(reason(false, 'bool', status)).toMatch(/"0" is not a member of enum/);
      expect(reason({ $numberDouble: '1.5' }, 'double', status)).toMatch(/"1.5" is not a member of enum/);
      expect(reason({ $date: 1500 }, 'datetime', status)).toMatch(/is not a member of enum/);
      expect(reason({ $oid: '69a4d3015a5a5a0001000001' }, 'objectId', status)).toMatch(/is not a member of enum/);
      // A quoted number (bigint, decimal) matches a member by text first, then counts as an index.
      expect(okValue({ $numberLong: '2' }, 'bigint', status)).toBe('2');
      expect(reason({ $numberLong: '5' }, 'bigint', status)).toMatch(/"5" is not a member of enum/);
      expect(okValue({ $numberLong: '7' }, 'bigint', col('c', 'enum', { collation: 'utf8mb4_0900_ai_ci', charLength: 1, octetLength: 4, members: ['7', '8'] }))).toBe('7');
      expect(reason({ a: 1 }, 'json', status)).toBe('"{\\"a\\":1}" is not a member of enum(3 values)');
      const flags = col('flags', 'set', { collation: 'utf8mb4_0900_ai_ci', charLength: 3, octetLength: 12, members: ['x', 'y'] });
      expect(okValue(3, 'int', flags)).toBe(3);
      expect(okValue(0, 'int', flags)).toBe(0);
      expect(reason(4, 'int', flags)).toBe('"4" is not a member of set(2 values); MySQL reads a number into SET as a bit mask over the members');
      expect(okValue('x,y', 'string', flags)).toBe('x,y');
    });
  });
});
