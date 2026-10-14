import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import mapLimit from '../../../src/runtime/mapLimit.js';

describe('mapLimit', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(n);
      inFlight -= 1;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
    expect(peak).toBe(2);
  });

  it('handles empty input and a limit above the length', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('rejects with the first error and starts no more items', async () => {
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await sleep(1);
      if (n === 2) throw new Error('two');
      return n;
    })).rejects.toThrow('two');
    expect(started.length).toBeLessThan(6);
  });
});
