import { describe, expect, it } from 'vitest';
import partPath from '../../../src/load/partPath.js';

describe('partPath', () => {
  it('names the local file by position, never by the manifest', () => {
    expect(partPath('/tmp/r', 0)).toBe('/tmp/r/part-000001.jsonl.gz');
    expect(partPath('/tmp/r', 41)).toBe('/tmp/r/part-000042.jsonl.gz');
  });
});
