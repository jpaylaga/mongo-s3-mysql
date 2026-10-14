import { describe, expect, it } from 'vitest';
import recordJson from '../../../src/layout/recordJson.js';

describe('recordJson', () => {
  it('pretty-prints with two spaces and a trailing newline, the one form every record takes', () => {
    expect(recordJson({ a: 1, b: [2] })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  });
});
