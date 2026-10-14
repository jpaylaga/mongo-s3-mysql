/** Full-jitter exponential backoff: a random wait in [0, min(maxMs, baseMs * 2^(attempt - 1))]. */
export default function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

  return Math.round(random() * ceiling);
}
