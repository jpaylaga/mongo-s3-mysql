import { describe, expect, it } from 'vitest';
import timeZoneSchema from '../../../src/mapping/timeZoneSchema.js';

describe('timeZoneSchema', () => {
  it('accepts IANA zones the runtime knows and refuses the rest with an example', () => {
    expect(timeZoneSchema.safeParse('UTC').success).toBe(true);
    expect(timeZoneSchema.safeParse('Asia/Manila').success).toBe(true);
    expect(timeZoneSchema.safeParse('Mars/Olympus').error?.issues[0]?.message).toBe('an IANA time zone like "UTC" or "Asia/Manila"');
  });
});
