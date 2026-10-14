import { describe, expect, it } from 'vitest';
import escapeControl from '../../../src/cli/escapeControl.js';

describe('escapeControl', () => {
  it('shows ESC, BEL and C1 controls as \\uXXXX escapes and leaves tabs, newlines and printable text alone', () => {
    expect(escapeControl('a\u001bb\u0007c\u009fd')).toBe('a\\u001bb\\u0007c\\u009fd');
    expect(escapeControl('tab\tnl\ncaf\u00e9 \u{1F600}')).toBe('tab\tnl\ncaf\u00e9 \u{1F600}');
    expect(escapeControl('\u007f')).toBe('\\u007f');
  });
});
