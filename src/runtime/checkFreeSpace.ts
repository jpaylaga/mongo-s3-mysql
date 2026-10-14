import { statfs } from 'node:fs/promises';
import formatCount from './formatCount.js';
import msmError from './msmError.js';

// Process-wide: every open part and in-flight download holds its budget here, so concurrent chunks
// cannot each pass the check against the same free bytes.
let reserved = 0;

/**
 * Requires `free >= minFreeMb + reserved + reserveBytes` on the volume of `dir`, then adds `reserveBytes`
 * to the process-wide reservation. The result releases it (idempotent).
 */
export default async function checkFreeSpace(dir: string, minFreeMb: number, reserveBytes = 0): Promise<() => void> {
  const stats = await statfs(dir);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const needed = minFreeMb * 1024 * 1024 + reserved + reserveBytes;
  if (free < needed) {
    const mb = (n: number) => `${formatCount(Math.round(n / 1024 / 1024))} MB`;
    throw msmError('disk', `${dir}: ${mb(free)} free, ${mb(needed)} needed (${mb(reserved)} reserved by running chunks, minFreeDiskMb ${minFreeMb})`);
  }
  reserved += reserveBytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reserved -= reserveBytes;
  };
}
