/**
 * Process exit codes. When several apply: sigint/sigterm, then error, drift, invalid, incomplete.
 */
const exitCodes = {
  ok: 0,
  error: 1,
  incomplete: 2,
  invalid: 3,
  drift: 4,
  sigint: 130,
  sigterm: 143,
} as const;

export default exitCodes;
