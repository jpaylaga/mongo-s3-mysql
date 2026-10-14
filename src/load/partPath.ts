import { join } from 'node:path';

/** The local file of part `i` (0-based): named by position, never by the manifest, which an archive could craft. */
export default function partPath(dir: string, i: number): string {
  return join(dir, `part-${String(i + 1).padStart(6, '0')}.jsonl.gz`);
}
