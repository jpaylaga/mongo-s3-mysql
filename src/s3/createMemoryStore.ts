import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import msmError from '../runtime/msmError.js';
import type { ObjectStore } from '../types.js';
import recordLimitBytes from './recordLimitBytes.js';

/** An in-process `ObjectStore` with S3's prefix and delimiter semantics, for tests and dry runs. */
export default function createMemoryStore(bucket = 'example-archive-bucket'): ObjectStore & { objects: Map<string, Buffer>; metadata: Map<string, Record<string, string>> } {
  const objects = new Map<string, Buffer>();
  const metadata = new Map<string, Record<string, string>>();
  return {
    bucket,
    objects,
    metadata,
    async putFile(key, path, opts) {
      if (opts.signal?.aborted) throw Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });
      objects.set(key, await readFile(path));
      metadata.set(key, { ...(opts.metadata ?? {}) });
    },
    async putText(key, body, _contentType) {
      objects.set(key, Buffer.from(body, 'utf8'));
      metadata.set(key, {});
      return createHash('sha256').update(body, 'utf8').digest('hex');
    },
    async head(key) {
      const body = objects.get(key);
      return body === undefined ? null : { bytes: body.length };
    },
    async getText(key, maxBytes = recordLimitBytes) {
      const body = objects.get(key);
      if (body === undefined) return null;
      if (body.length > maxBytes) throw msmError('record', `${key}: ${body.length} bytes exceeds the ${maxBytes}-byte record limit`);
      return body.toString('utf8');
    },
    async getStream(key) {
      const body = objects.get(key);
      return body === undefined ? null : Readable.from([Buffer.from(body)]);
    },
    async list(prefix, delimiter) {
      const keys: string[] = [];
      const prefixes = new Set<string>();
      for (const key of [...objects.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        if (delimiter === undefined) { keys.push(key); continue; }
        const rest = key.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at === -1) keys.push(key);
        else prefixes.add(prefix + rest.slice(0, at + delimiter.length));
      }
      return { keys, prefixes: [...prefixes].sort() };
    },
  };
}
