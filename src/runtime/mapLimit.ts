/**
 * `Promise.all` with at most `limit` items in flight, results in input order. The first rejection
 * stops new items from starting and rejects once started ones settle, so a fatal error never leaves
 * work half-observed.
 */
export default async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: unknown[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const i = next;

      next += 1;

      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failures.push(err);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));

  if (failures.length > 0) throw failures[0];

  return results;
}
