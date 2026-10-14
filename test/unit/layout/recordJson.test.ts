import { describe, expect, it } from 'vitest';
import recordJson from '#layout/recordJson';

describe('recordJson', () => {
  it('pretty-prints with two spaces and a trailing newline, the one form every record has', () => {
    expect(recordJson({ a: 1, b: [2] })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  });
});
