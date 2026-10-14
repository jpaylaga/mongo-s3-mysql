import { describe, expect, it } from 'vitest';
import smallCollectionDocs from '#runtime/smallCollectionDocs';

describe('smallCollectionDocs', () => {
  it('is the one 1,000,000 limit inventory and rest: auto share', () => {
    expect(smallCollectionDocs).toBe(1_000_000);
  });
});
