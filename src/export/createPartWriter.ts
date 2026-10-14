import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Gzip } from 'node:zlib';
import checkFreeSpace from '#runtime/checkFreeSpace';
import createHashCounter from '#runtime/createHashCounter';
import type { ClosedPart, HashCounter, PartWriter } from '#types';

interface OpenPart {
  n: number;
  path: string;
  name: string;
  gzip: Gzip;
  done: Promise<void>;
  failure: unknown;
  counter: HashCounter;
  lines: number;
  uncompressed: number;
  release: () => void;
}

const partName = (n: number) => `part-${String(n).padStart(6, '0')}.jsonl.gz`;

/**
 * Streams lines through gzip into numbered part files: nothing is buffered whole, the sha256 and
 * byte count come from the compressed stream itself, and a part closes at `maxDocs` lines or
 * `maxBytes` of uncompressed text. A part opens lazily, after its disk reservation, so an empty
 * chunk never touches the disk.
 */
export default function createPartWriter(options: {
  dir: string;
  gzipLevel: number;
  maxDocs: number;
  maxBytes: number;
  minFreeMb: number;
}): PartWriter {
  let next = 1;
  let current: OpenPart | null = null;

  const open = async (): Promise<OpenPart> => {
    const release = await checkFreeSpace(options.dir, options.minFreeMb, options.maxBytes);
    const n = next;

    next += 1;

    const path = join(options.dir, partName(n));
    const counter = createHashCounter();

    const part: OpenPart = {
      n,
      path,
      name: partName(n),
      gzip: createGzip({ level: options.gzipLevel }),
      done: Promise.resolve(),
      failure: undefined,
      counter,
      lines: 0,
      uncompressed: 0,
      release,
    };

    // Owner-only, and never an existing path: `wx` refuses a file or symlink planted at the part's
    // name.
    part.done = pipeline(
      part.gzip,
      counter.stream,
      createWriteStream(path, { mode: 0o600, flags: 'wx' })
    );

    // Recorded here so a write that is waiting on drain sees the failure instead of hanging.
    part.done.catch((err: unknown) => {
      part.failure = err ?? new Error('part pipeline failed');
    });

    return part;
  };

  const close = async (part: OpenPart): Promise<ClosedPart> => {
    try {
      part.gzip.end();
      await part.done;
    } finally {
      part.release();
    }

    return {
      n: part.n,
      path: part.path,
      name: part.name,
      bytes: part.counter.bytes(),
      sha256: part.counter.digest(),
      lines: part.lines,
    };
  };

  return {
    async write(line) {
      if (current === null) current = await open();

      const part = current;

      if (part.failure !== undefined) throw part.failure;

      const text = `${line}\n`;
      const ok = part.gzip.write(text);

      part.lines += 1;
      part.uncompressed += Buffer.byteLength(text, 'utf8');

      if (!ok) await Promise.race([once(part.gzip, 'drain'), part.done]);

      if (part.failure !== undefined) throw part.failure;

      if (part.lines >= options.maxDocs || part.uncompressed >= options.maxBytes) {
        current = null;

        return close(part);
      }

      return null;
    },
    async finish() {
      if (current === null) return null;

      const part = current;

      current = null;

      return close(part);
    },
    async abort() {
      if (current === null) return;

      const part = current;

      current = null;
      part.gzip.destroy();
      await part.done.catch(() => undefined);
      part.release();
      await unlink(part.path).catch(() => undefined);
    },
  };
}
