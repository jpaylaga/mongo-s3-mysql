import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import msmError from '#runtime/msmError';

/**
 * Well above the 16 MiB BSON limit times the canonical EJSON expansion; a longer line is an attack
 * or corruption.
 */
const maxLineChars = 256 * 1024 * 1024;

/**
 * Lines of a gzipped UTF-8 text stream, never buffering the whole object. The decoder is fatal (bad
 * bytes end the read with a `parse` error rather than U+FFFD rows in MySQL), a leading BOM is
 * dropped and a missing final newline still yields the last line. Only the newly decoded text is
 * searched for newlines, so a long line costs linear time, and a line past `maxChars` ends the read
 * with its own `parse` error.
 */
export default async function* readGzipLines(
  source: Readable,
  maxChars: number = maxLineChars
): AsyncGenerator<string> {
  const gunzip = createGunzip();
  const done = pipeline(source, gunzip);

  done.catch(() => undefined);

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const pending: string[] = [];
  let pendingChars = 0;

  const tooLong = () =>
    msmError('parse', `line longer than ${Math.round(maxChars / 1024 / 1024)} MiB`);

  try {
    for await (const chunk of gunzip) {
      const text = decoder.decode(chunk as Buffer, { stream: true });
      let start = 0;
      let nl = text.indexOf('\n');

      while (nl !== -1) {
        const piece = text.slice(start, nl);

        if (pendingChars + piece.length > maxChars) throw tooLong();

        yield pending.length === 0 ? piece : `${pending.join('')}${piece}`;
        pending.length = 0;
        pendingChars = 0;
        start = nl + 1;
        nl = text.indexOf('\n', start);
      }

      if (start < text.length) {
        const rest = text.slice(start);

        pending.push(rest);
        pendingChars += rest.length;

        if (pendingChars > maxChars) throw tooLong();
      }
    }

    const tail = decoder.decode();

    if (tail.length > 0) {
      pending.push(tail);
      pendingChars += tail.length;
    }
  } catch (err) {
    if (err instanceof TypeError) throw msmError('parse', 'invalid UTF-8 in part', { cause: err });

    throw err;
  }

  await done;

  if (pendingChars > 0) yield pending.join('');
}
