import { describe, expect, it } from 'vitest';
import quoteId from '#mysql/quoteId';

describe('quoteId', () => {
  it('backtick-quotes and doubles embedded backticks', () => {
    expect(quoteId('audit_log_entries')).toBe('`audit_log_entries`');
    expect(quoteId('we`ird')).toBe('`we``ird`');
    expect(quoteId('a'.repeat(64))).toBe(`\`${'a'.repeat(64)}\``);
  });

  it('refuses empty, over-long and NUL-containing names', () => {
    expect(() => quoteId('')).toThrow(/invalid MySQL identifier/);
    expect(() => quoteId('a'.repeat(65))).toThrow(/1 to 64 characters/);
    expect(() => quoteId('a\0b')).toThrow(/no NUL/);
  });
});
