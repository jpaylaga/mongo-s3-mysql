import { describe, expect, it } from 'vitest';
import textLimit from '#mapping/textLimit';
import { col } from '../mysql/fakeTables.js';

describe('textLimit', () => {
  it('no limit without a live column; code points for char/varchar, bytes for text/binary', () => {
    expect(textLimit('x'.repeat(100_000), null)).toBeNull();

    expect(
      textLimit('\u{1F600}\u{1F600}', col('c', 'varchar', { charLength: 2, octetLength: 8 }))
    ).toBeNull();

    expect(
      textLimit(
        '\u{1F600}\u{1F600}\u{1F600}',
        col('c', 'varchar', { charLength: 2, octetLength: 8 })
      )
    ).toBe('3 characters exceed varchar(2)');

    expect(textLimit('\u00e9\u00e9', col('c', 'text', { octetLength: 3 }))).toBe(
      '4 bytes exceed text (3 bytes)'
    );

    expect(
      textLimit('\u00e9\u00e9', col('c', 'blob', { collation: 'binary', octetLength: 3 }))
    ).toBe('4 bytes exceed blob (3 bytes)');

    expect(textLimit('x'.repeat(10), col('c', 'json'))).toBeNull();
  });

  it('checks the character set after the length, from the collation prefix', () => {
    expect(
      textLimit(
        '\u{1F600}',
        col('c', 'varchar', { collation: 'utf8mb3_unicode_ci', charLength: 5, octetLength: 15 })
      )
    ).toBe('U+1F600 is outside the utf8mb3 character set of varchar (utf8mb3_unicode_ci)');

    expect(
      textLimit(
        '\u{1F600}',
        col('c', 'varchar', { collation: 'utf8mb4_0900_ai_ci', charLength: 5, octetLength: 20 })
      )
    ).toBeNull();

    expect(
      textLimit(
        '\u0081',
        col('c', 'varchar', { collation: 'latin1_bin', charLength: 5, octetLength: 5 })
      )
    ).toBeNull();

    expect(
      textLimit(
        '\u0100',
        col('c', 'varchar', { collation: 'latin1_bin', charLength: 5, octetLength: 5 })
      )
    ).toBe('U+0100 is outside the latin1 character set of varchar (latin1_bin)');
  });
});
