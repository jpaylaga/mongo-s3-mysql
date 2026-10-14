import { describe, expect, it } from 'vitest';
import identifierSchema from '../../../src/mapping/identifierSchema.js';

describe('identifierSchema', () => {
  it('accepts MySQL identifiers up to 64 characters and names the rule on refusal', () => {
    expect(identifierSchema.safeParse('_msm_chunk').success).toBe(true);
    expect(identifierSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(identifierSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(identifierSchema.safeParse('2fa').success).toBe(false);
    expect(identifierSchema.safeParse('a-b').error?.issues[0]?.message).toBe('letters, digits, underscore; max 64');
  });
});
