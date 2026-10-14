import { describe, expect, it } from 'vitest';
import maxDecimalExponent from '#mapping/maxDecimalExponent';

describe('maxDecimalExponent', () => {
  it("covers Decimal128's +/-6176 with a little room, nothing a crafted exponent could use", () => {
    expect(maxDecimalExponent).toBe(6200);
    expect(maxDecimalExponent).toBeGreaterThan(6176);
  });
});
