import { pipeline } from 'node:stream/promises';
import lineHasId from '#ejson/lineHasId';
import readGzipLines from '#ejson/readGzipLines';
import buildValidation from '#export/buildValidation';
import createHashCounter from '#runtime/createHashCounter';
import errorMessage from '#runtime/errorMessage';
import formatUtc from '#runtime/formatUtc';
import isMsmError from '#runtime/isMsmError';
import msmError from '#runtime/msmError';
import toolVersion from '#runtime/toolVersion';
import type {
  ChunkCheck,
  CountsRecord,
  Layout,
  ObjectStore,
  ParseCheckRecord,
  PartRef,
  ResolvedManifest,
  RunContext,
} from '#types';

// Enough parse failures to show the pattern without turning one corrupt part into thousands of
// error lines.
const parseErrorsListed = 5;
const abortCheckEvery = 10_000;

interface PartResult {
  lines: number;
  parseErrors: number;
  missingIds: number;
  firstLine: string | null;
  gzipOk: boolean | null;
  bytesOk: boolean;
  sha256Ok: boolean | null;
  decoded: boolean;
}

const isZlibError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as { code?: unknown }).code === 'string' &&
  (err as { code: string }).code.startsWith('Z_');

/**
 * The object's size and sha256 alone, read again when decoding stopped before the end of the
 * stream.
 */
async function hashObject(
  store: ObjectStore,
  part: PartRef & { key: string }
): Promise<{ bytes: number; digest: string } | null> {
  const source = await store.getStream(part.key);

  if (source === null) return null;

  const counter = createHashCounter();

  counter.stream.resume();
  await pipeline(source, counter.stream);

  return { bytes: counter.bytes(), digest: counter.digest() };
}

/**
 * One streamed pass over a part: the bytes feed the sha256 and byte count while gunzip and the line
 * checks run on the same stream, so an intact part is read from S3 exactly once and never buffered
 * whole. When decoding stops early (gunzip or UTF-8), the integrity verdict comes from a second,
 * hash-only read, so the damage is named for what it is and the line checks (which never reached
 * the end) are not reported.
 */
async function readPart(
  ctx: RunContext,
  store: ObjectStore,
  part: PartRef & { key: string },
  errors: string[]
): Promise<PartResult | null> {
  const source = await store.getStream(part.key);

  if (source === null) {
    errors.push(`${part.name}: object missing`);

    return null;
  }

  const counter = createHashCounter();
  const piped = pipeline(source, counter.stream);

  piped.catch(() => undefined);

  const result: PartResult = {
    lines: 0,
    parseErrors: 0,
    missingIds: 0,
    firstLine: null,
    gzipOk: true,
    bytesOk: false,
    sha256Ok: null,
    decoded: true,
  };

  try {
    for await (const line of readGzipLines(counter.stream)) {
      if (result.lines % abortCheckEvery === 0 && ctx.signal.aborted)
        throw msmError('interrupted', `${part.name}: interrupted`);

      result.lines += 1;

      if (result.firstLine === null) result.firstLine = line;

      const id = lineHasId(line);

      if (id === null) {
        result.parseErrors += 1;

        if (result.parseErrors <= parseErrorsListed)
          errors.push(`${part.name}: line ${result.lines} is not JSON`);
      } else if (!id) {
        result.missingIds += 1;

        if (result.missingIds <= parseErrorsListed)
          errors.push(`${part.name}: line ${result.lines} has no _id`);
      }
    }

    await piped;
  } catch (err) {
    result.decoded = false;
    source.destroy();

    if (isZlibError(err)) {
      result.gzipOk = false;
      errors.push(`${part.name}: gunzip failed (${errorMessage(err)})`);
    } else if (isMsmError(err, 'parse')) {
      // The bytes were not decoded to the end, so gunzip has no verdict; the text was the problem.
      result.gzipOk = null;
      result.parseErrors += 1;

      errors.push(
        `${part.name}: ${err.message === 'invalid UTF-8 in part' ? 'invalid UTF-8' : err.message}`
      );
    } else {
      throw err;
    }
  }

  if (result.parseErrors > parseErrorsListed)
    errors.push(`${part.name}: ${result.parseErrors - parseErrorsListed} more lines are not JSON`);

  if (result.missingIds > parseErrorsListed)
    errors.push(`${part.name}: ${result.missingIds - parseErrorsListed} more lines have no _id`);

  let bytes = counter.bytes();
  let digest = result.decoded ? counter.digest() : null;

  if (!result.decoded) {
    const whole = await hashObject(store, part);

    if (whole === null) {
      errors.push(`${part.name}: object missing`);

      return null;
    }

    bytes = whole.bytes;
    digest = whole.digest;
  }

  result.bytesOk = bytes === part.bytes;

  if (!result.bytesOk)
    errors.push(`${part.name}: read ${bytes} bytes, manifest says ${part.bytes}`);

  result.sha256Ok = digest === part.sha256;

  if (!result.sha256Ok)
    errors.push(
      `${part.name}: sha256 ${String(digest).slice(0, 12)} differs from the ` +
        `manifest's ${part.sha256.slice(0, 12)}`
    );

  if (result.decoded && part.lines !== null && result.lines !== part.lines)
    errors.push(`${part.name}: ${result.lines} lines, manifest says ${part.lines}`);

  return result;
}

/**
 * A valid sidecar body is `<sha256>  <name>\n`, well under this; a larger object at that key is
 * damage, not a sidecar.
 */
const sidecarLimitBytes = 1024;

/**
 * The sidecar is read only from under the chunk's raw prefix; one addressed elsewhere was already
 * reported by checkManifest.
 */
async function checkSidecar(
  store: ObjectStore,
  layout: Layout,
  rawPrefix: string,
  part: PartRef,
  errors: string[]
): Promise<boolean> {
  if (part.checksum_s3_uri === null) {
    errors.push(`${part.name}: no checksum_s3_uri`);

    return false;
  }

  const key = layout.keyOf(part.checksum_s3_uri);
  let body: string | null;

  try {
    body =
      key === null || !key.startsWith(rawPrefix)
        ? null
        : await store.getText(key, sidecarLimitBytes);
  } catch (err) {
    if (!isMsmError(err, 'record')) throw err;

    errors.push(`${part.name}: ${err.message}`);

    return false;
  }

  if (body === null) {
    errors.push(`${part.name}: sidecar missing`);

    return false;
  }

  if (body !== `${part.sha256}  ${part.name}\n`) {
    errors.push(`${part.name}: sidecar body differs from "<sha256>  <name>"`);

    return false;
  }

  return true;
}

/**
 * The record and shape rules: everything that can be judged from the manifest alone
 * (docs/acceptance.md lists them).
 */
function checkManifest(layout: Layout, resolved: ResolvedManifest, errors: string[]): void {
  const { manifest: m, parts, id } = resolved;

  if (m.run_id !== resolved.runId)
    errors.push(`run_id ${m.run_id} differs from the key's ${resolved.runId}`);

  if (m.collection !== resolved.collection)
    errors.push(`collection ${m.collection} differs from the key's ${resolved.collection}`);

  for (const [key, value] of Object.entries(layout.partition)) {
    const found = (m as Record<string, unknown>)[key];

    if (found !== value)
      errors.push(
        `partition ${key} is ${JSON.stringify(found)}, config says ${JSON.stringify(value)}`
      );
  }

  if (id.mode !== m.mode) errors.push(`mode ${m.mode} differs from the run id's ${id.mode}`);

  const expectedMatch =
    m.source_count === m.exported_count &&
    (m.source_count_after === undefined || m.source_count_after === m.exported_count);

  if (m.counts_match !== expectedMatch)
    errors.push(
      `counts_match ${m.counts_match} but source_count ${m.source_count}, ` +
        `exported_count ${m.exported_count}` +
        (m.source_count_after === undefined ? '' : `, source_count_after ${m.source_count_after}`)
    );

  if ((m.file === null) !== (parts.length === 0))
    errors.push(
      m.file === null ? 'file is null but parts[] is present' : 'file is set but no parts resolved'
    );

  if (parts.length === 0 && m.exported_count !== 0)
    errors.push(`exported_count ${m.exported_count} with no parts`);

  if (m.file !== null && m.parts !== undefined) {
    const first = m.parts[0];

    if (
      first === undefined ||
      first.name !== m.file.name ||
      first.sha256 !== m.file.sha256 ||
      first.bytes !== m.file.bytes
    )
      errors.push('file is not parts[0]');
  }

  if (m.mode === 'manifest-only') {
    if (m.format !== 'manifest_only') errors.push(`manifest-only chunk has format ${m.format}`);

    if (m.first_id !== null || m.last_id !== null) errors.push('manifest-only chunk has ids');

    if (m.checksum_s3_uri !== null) errors.push('manifest-only chunk has a checksum_s3_uri');
  } else if (m.format !== 'canonical_extended_jsonl_gzip') {
    errors.push(`${m.mode} chunk has format ${m.format}`);
  }

  const rawPrefix = layout.rawPrefix(resolved.collection, id.window, resolved.runId);

  for (const part of parts) {
    for (const uri of [part.s3_uri, part.checksum_s3_uri]) {
      if (uri === null) continue;

      const key = layout.keyOf(uri);

      if (key === null) errors.push(`${part.name}: ${uri} is outside s3://${layout.bucket}/`);
      else if (!key.startsWith(rawPrefix))
        errors.push(`${part.name}: ${uri} is outside the chunk's raw prefix`);
    }

    // The name is what the sidecar body and the local file carry; it must be the object's own last
    // segment.
    const key = layout.keyOf(part.s3_uri);

    if (key !== null && key.slice(key.lastIndexOf('/') + 1) !== part.name)
      errors.push(
        `${part.name}: name differs from the object key's ${key.slice(key.lastIndexOf('/') + 1)}`
      );
  }
}

/**
 * Re-reads one chunk from S3 and judges it against its manifest. Damage is reported in `errors` and
 * never thrown; only operational failures (S3 refusing a read) throw, so the chunk attempt can
 * retry them. Parts are read to the end even after the first error, so one run lists everything.
 */
export default async function verifyChunk(
  ctx: RunContext,
  store: ObjectStore,
  layout: Layout,
  resolved: ResolvedManifest
): Promise<ChunkCheck> {
  const { manifest: m, parts } = resolved;
  const errors: string[] = [];

  checkManifest(layout, resolved, errors);

  // A part addressed outside the chunk's raw prefix (`key` null) was reported by checkManifest;
  // reading it would only add a second, misleading "object missing" line.
  const rawPrefix = layout.rawPrefix(resolved.collection, resolved.id.window, resolved.runId);
  const readable = parts.filter((p): p is PartRef & { key: string } => p.key !== null);
  let lines = 0;
  let parseErrors = 0;
  let missingIds = 0;
  let firstLine: string | null = null;
  let gzipOk: boolean | null = null;
  let bytesOk: boolean | null = null;
  let sha256Ok: boolean | null = null;
  let sidecarOk: boolean | null = null;

  const and = (acc: boolean | null, v: boolean | null): boolean | null =>
    acc === false || v === false ? false : acc === null ? v : v === null ? acc : true;

  let unread = 0;
  let allDecoded = true;

  for (const part of readable) {
    if (ctx.signal.aborted) throw msmError('interrupted', `${resolved.runId}: interrupted`);

    const head = await store.head(part.key);

    if (head === null) {
      errors.push(`${part.name}: object missing`);
      bytesOk = false;
      unread += 1;

      continue;
    }

    if (head.bytes !== part.bytes)
      errors.push(`${part.name}: object is ${head.bytes} bytes, manifest says ${part.bytes}`);

    sidecarOk = and(sidecarOk, await checkSidecar(store, layout, rawPrefix, part, errors));

    const read = await readPart(ctx, store, part, errors);

    if (read === null) {
      bytesOk = false;
      unread += 1;

      continue;
    }

    lines += read.lines;
    parseErrors += read.parseErrors;
    missingIds += read.missingIds;

    if (firstLine === null) firstLine = read.firstLine;

    if (!read.decoded) allDecoded = false;

    gzipOk = and(gzipOk, read.gzipOk);
    bytesOk = and(bytesOk, head.bytes === part.bytes && read.bytesOk);
    sha256Ok = and(sha256Ok, read.sha256Ok);
  }

  // The total only means something when every part was decoded whole; a missing or corrupt part
  // already has its line.
  if (
    readable.length === parts.length &&
    parts.length > 0 &&
    unread === 0 &&
    allDecoded &&
    lines !== m.exported_count
  )
    errors.push(`${lines} lines, exported_count ${m.exported_count}`);

  const ok = errors.length === 0;
  // The exporter's key sets come from the one builder export uses; verify adds its verdict on top.
  const base = buildValidation(m, firstLine, gzipOk);
  const counts: CountsRecord = { ...base.counts, verified_lines: lines };

  const parseCheck: ParseCheckRecord = {
    ...base.parseCheck,
    ok,
    lines,
    parse_errors: parseErrors,
    missing_ids: missingIds,
    bytes_ok: bytesOk,
    sha256_ok: sha256Ok,
    sidecar_ok: sidecarOk,
    manifest_sha256: resolved.sha256,
    verified_at: formatUtc(ctx.now(), 'offset'),
    errors,
    tool: toolVersion,
  };

  return {
    runId: resolved.runId,
    batchId: resolved.batchId,
    collection: resolved.collection,
    ok,
    lines,
    errors,
    counts,
    parseCheck,
  };
}
