import msmError from '../runtime/msmError.js';

/**
 * A BIGINT counter arrives as a string under `bigNumberStrings` (or as a bigint); anything past 2^53 - 1
 * cannot be trusted as a JS number, so it is refused instead of rounded. `what` names the
 * value in the fatal message; a null or undefined value (an empty aggregate) reads as 0.
 */
export default function toSafeNumber(value: unknown, what: string): number {
  const n = typeof value === 'bigint' ? value : BigInt(String(value ?? 0));
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw msmError('mysql', `${what} ${n} is outside 0..2^53-1`, { fatal: true });
  return Number(n);
}
