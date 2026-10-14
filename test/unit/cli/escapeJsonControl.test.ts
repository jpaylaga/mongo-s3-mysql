import { describe, expect, it } from 'vitest';
import escapeJsonControl from '#cli/escapeJsonControl';

describe('escapeJsonControl', () => {
  it('escapes DEL and the C1 controls JSON.stringify leaves raw, keeping the JSON valid', () => {
    const json = JSON.stringify({ id: 'x\u009b\u007f\u0085y', n: 1 });

    expect(json).toContain('\u009b');

    const safe = escapeJsonControl(json);

    expect(safe).toBe('{"id":"x\\u009b\\u007f\\u0085y","n":1}');
    expect(JSON.parse(safe)).toEqual({ id: 'x\u009b\u007f\u0085y', n: 1 });
    // C0 controls are already escaped by JSON.stringify and stay as they are.
    expect(escapeJsonControl(JSON.stringify('a\u001bb'))).toBe('"a\\u001bb"');
  });
});
