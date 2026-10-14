import { describe, expect, it } from 'vitest';
import maxDecimalExponent from '../../../src/mapping/maxDecimalExponent.js';

describe('maxDecimalExponent', () => {
  it('covers Decimal128\'s +/-6176 with a little room and nothing a crafted exponent could use', () => {
    expect(maxDecimalExponent).toBe(6200);
    expect(maxDecimalExponent).toBeGreaterThan(6176);
  });
});
