import isObject from '../ejson/isObject.js';
import readGzipLines from '../ejson/readGzipLines.js';
import msmError from '../runtime/msmError.js';
import type { JsonObject, ObjectStore, PartRef, ResolvedManifest, RunContext } from '../types.js';

/**
 * Up to `sampleSize` documents read from at most `maxParts` parts of the chunks. Parts are picked at even
 * intervals over the whole list (round(i * (n - 1) / (k - 1))), so old and new windows are both
 * represented, and within them every k-th line is kept, so a part's head does not dominate the sample. The
 * stride rounds up, so at most `sampleSize` lines are taken and the last (newest) parts are reached.
 */
export default async function sampleDocs(
  ctx: RunContext,
  store: ObjectStore,
  manifests: ResolvedManifest[],
  opts: { sampleSize: number; maxParts: number },
): Promise<JsonObject[]> {
  const parts: { part: PartRef; lines: number; collection: string }[] = manifests.flatMap((m) =>
    m.parts.map((part) => ({ part, lines: part.lines ?? m.manifest.exported_count, collection: m.collection })));
  if (parts.length === 0) return [];

  const k = Math.min(opts.maxParts, parts.length);
  const chosen = k === 1
    ? [parts[0] as (typeof parts)[number]]
    : Array.from({ length: k }, (_, i) => parts[Math.round((i * (parts.length - 1)) / (k - 1))] as (typeof parts)[number]);
  const totalLines = chosen.reduce((sum, c) => sum + c.lines, 0);
  const stride = Math.max(1, Math.ceil(totalLines / opts.sampleSize));

  const docs: JsonObject[] = [];
  let lineNo = 0;
  let skipped = 0;
  for (const { part } of chosen) {
    if (docs.length >= opts.sampleSize) break;
    // A part addressed outside its chunk's raw prefix is a record error; S3 is never asked for it.
    if (part.key === null) throw msmError('record', `${part.name}: s3_uri ${part.s3_uri} is outside the chunk's raw prefix; run verify`);
    const stream = await store.getStream(part.key);
    if (stream === null) throw msmError('s3', `${part.key}: part is missing; run verify`);
    for await (const line of readGzipLines(stream)) {
      if (ctx.signal.aborted) throw msmError('interrupted', 'infer: interrupted');
      const take = lineNo % stride === 0;
      lineNo += 1;
      if (!take) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isObject(parsed)) {
        skipped += 1;
        continue;
      }
      docs.push(parsed);
      if (docs.length >= opts.sampleSize) break;
    }
  }
  if (skipped > 0) {
    ctx.emit({ type: 'warn', command: ctx.command, message: `${chosen[0]?.collection ?? 'sample'}: ${skipped} sampled lines are not JSON documents; run verify` });
  }
  return docs;
}
