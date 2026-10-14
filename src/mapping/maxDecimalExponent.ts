/** Decimal128's exponent range is +/-6176 and MySQL DECIMAL holds 65 digits; anything beyond is not a value to expand. */
const maxDecimalExponent = 6200;

export default maxDecimalExponent;
