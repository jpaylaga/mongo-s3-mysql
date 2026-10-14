import type { ColumnInfo } from '#types';

const textTypes = new Set(['tinytext', 'text', 'mediumtext', 'longtext']);
const binaryTypes = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob']);

function countCodePoints(s: string): number {
  let n = 0;

  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) i += 1;

    n += 1;
  }

  return n;
}

/**
 * The 27 code points cp1252 (MySQL's latin1) places in 0x80..0x9F; the other five bytes there are
 * C1 controls.
 */
const cp1252High = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178, 0x81, 0x8d, 0x8f, 0x90, 0x9d,
]);

/**
 * The first character the column's character set cannot hold, from the collation prefix: utf8mb3
 * (also spelled `utf8_`) and ucs2 stop at U+FFFF, latin1 is cp1252, ascii is 7-bit. utf8mb4 and
 * binary hold everything.
 */
function charsetLimit(text: string, dataType: string, collation: string): string | null {
  const charset = collation === 'binary' ? 'binary' : (collation.split('_')[0] ?? collation);
  let fits: (cp: number) => boolean;

  if (charset === 'utf8mb3' || charset === 'utf8' || charset === 'ucs2') fits = cp => cp <= 0xffff;
  else if (charset === 'latin1')
    fits = cp => cp <= 0x7f || (cp >= 0xa0 && cp <= 0xff) || cp1252High.has(cp);
  else if (charset === 'ascii') fits = cp => cp <= 0x7f;
  else return null;

  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;

    if (!fits(cp))
      return (
        `U+${cp.toString(16).toUpperCase().padStart(4, '0')} is outside the ` +
        `${charset} character set of ${dataType} (${collation})`
      );
  }

  return null;
}

/**
 * The live column's rule for text, or null when the value fits: code points for CHAR and VARCHAR,
 * UTF-8 bytes for the text and binary types, then the character set. Without a live column there is
 * no limit.
 */
export default function textLimit(text: string, target: ColumnInfo | null): string | null {
  if (target === null) return null;

  const base = target.dataType.toLowerCase().split(' ')[0] ?? '';

  if ((base === 'char' || base === 'varchar') && target.charLength !== null) {
    const n = countCodePoints(text);

    if (n > target.charLength)
      return `${n} characters exceed ${target.dataType}(${target.charLength})`;
  } else if ((textTypes.has(base) || binaryTypes.has(base)) && target.octetLength !== null) {
    const bytes = Buffer.byteLength(text, 'utf8');

    if (bytes > target.octetLength)
      return `${bytes} bytes exceed ${target.dataType} (${target.octetLength} bytes)`;
  }

  return target.collation === null ? null : charsetLimit(text, target.dataType, target.collation);
}
