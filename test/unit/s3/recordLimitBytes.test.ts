import { describe, expect, it } from 'vitest';
import recordLimitBytes from '#s3/recordLimitBytes';

describe('recordLimitBytes', () => {
  it("is 64 MiB: room for a manifest with very many parts, far below V8's string limit", () => {
    expect(recordLimitBytes).toBe(64 * 1024 * 1024);
  });
});
