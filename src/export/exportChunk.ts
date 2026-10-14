import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import docToLine from '#ejson/docToLine';
import buildChunkManifest from '#export/buildChunkManifest';
import buildValidation from '#export/buildValidation';
import canonicalFilter from '#export/canonicalFilter';
import createPartWriter from '#export/createPartWriter';
import restGapTerm from '#export/restGapTerm';
import uploadPart from '#export/uploadPart';
import readRecord from '#layout/readRecord';
import recordJson from '#layout/recordJson';
import recordSchemas from '#layout/recordSchemas';
import countDocs from '#mongo/countDocs';
import streamCursor from '#mongo/streamCursor';
import streamKeyset from '#mongo/streamKeyset';
import formatCount from '#runtime/formatCount';
import isMsmError from '#runtime/isMsmError';
import msmError from '#runtime/msmError';
import tempDirOf from '#runtime/tempDirOf';
import toolVersion from '#runtime/toolVersion';
import type {
  ChunkManifest,
  ChunkOutcome,
  ChunkPlan,
  ClosedPart,
  ExportDeps,
  PartRef,
  RunContext,
} from '#types';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * `first_id` / `last_id` as the records carry them: hex for ObjectIds, the string itself, else
 * canonical EJSON.
 */
const idText = (id: unknown): string => {
  if (id instanceof ObjectId) return id.toHexString();

  if (typeof id === 'string') return id;

  return BSON.EJSON.stringify(id, { relaxed: false });
};

/**
 * A rest chunk's filter with its live-write gap counted from this attempt; the manifest records
 * what was used.
 */
function attemptPlan(plan: ChunkPlan, attemptStart: Date): ChunkPlan {
  if (plan.liveGap === undefined) return plan;

  const terms = [...((plan.filter.$or as Document[] | undefined) ?? [])];

  terms[terms.length - 1] = restGapTerm(plan.liveGap, attemptStart);

  const filter: Document = { $or: terms };

  return {
    ...plan,
    filter,
    filterRecord: { ...plan.filterRecord, query: canonicalFilter(filter) },
  };
}

/**
 * The chunk's count under its planned hint, falling back to an unhinted count where the server
 * refuses the hint (DocumentDB).
 */
const countSource = (ctx: RunContext, deps: ExportDeps, plan: ChunkPlan, hint: string | null) =>
  countDocs(
    ctx,
    deps.mongo.db.collection(plan.collection),
    plan.filter,
    hint,
    `countDocuments ${plan.runId}`
  );

/**
 * Validation records, then the manifest (its presence with counts_match true is the commit,
 * invariant I1). Only a committed manifest goes into the local cache: a flagged one must be found
 * pending on resume.
 */
async function writeRecords(
  deps: ExportDeps,
  plan: ChunkPlan,
  manifest: ChunkManifest,
  firstLine: string | null,
  gzipOk: boolean | null
): Promise<string> {
  const { counts, parseCheck } = buildValidation(manifest, firstLine, gzipOk);

  await deps.store.putText(
    deps.layout.counts(plan.collection, plan.runId),
    recordJson(counts),
    'application/json'
  );

  await deps.store.putText(
    deps.layout.parseCheck(plan.collection, plan.runId),
    recordJson(parseCheck),
    'application/json'
  );

  const key = deps.layout.chunkManifest(plan.collection, plan.runId);
  const sha256 = await deps.store.putText(key, recordJson(manifest), 'application/json');

  if (manifest.counts_match) {
    await deps.ledger.append(plan.runId, {
      manifest_key: key,
      bucket: deps.layout.bucket,
      manifest_sha256: sha256,
      exported_count: manifest.exported_count,
    });
  }

  return sha256;
}

/**
 * Whether another exporter committed this chunk since the plan was made (two runners on one batch
 * from different state directories): a committed manifest is never overwritten (invariant I2), so
 * the attempt is skipped. Only an unreadable record counts as "not committed" (the write below
 * replaces it); an S3 failure propagates, so a transient one retries the chunk and a permission
 * problem stops the run before any read.
 */
async function committedMeanwhile(deps: ExportDeps, plan: ChunkPlan): Promise<boolean> {
  try {
    const record = await readRecord(
      deps.store,
      deps.layout.chunkManifest(plan.collection, plan.runId),
      recordSchemas.chunkManifest
    );

    return record !== null && record.value.counts_match;
  } catch (err) {
    if (isMsmError(err, 'record')) return false;

    throw err;
  }
}

/**
 * One attempt at one chunk: count, stream every document through the part writer with one upload in
 * flight, count again, then write validation records and the manifest. A chunk that counts zero
 * reads nothing (a rest chunk's empty filter would otherwise scan the whole collection under
 * `_id_`); a write that lands meanwhile still shows in the after count. A count mismatch throws
 * while attempts remain (the whole chunk restarts at the same keys) and flags the chunk on the last
 * one. Every throw cleans the temp directory; uploaded parts stay, since the retry overwrites them.
 */
export default async function exportChunk(
  ctx: RunContext,
  deps: ExportDeps,
  planned: ChunkPlan,
  attempt: number
): Promise<ChunkOutcome> {
  const { config } = ctx;

  const outcome = (
    status: ChunkOutcome['status'],
    extra: Partial<ChunkOutcome> = {}
  ): ChunkOutcome => ({ chunk: planned.runId, collection: planned.collection, status, ...extra });

  const startedAt = ctx.now();
  const plan = attemptPlan(planned, startedAt);

  ctx.emit({
    type: 'chunk',
    command: ctx.command,
    chunk: plan.runId,
    status: 'start',
    detail: attempt > 1 ? `attempt ${attempt}` : undefined,
  });

  if (await committedMeanwhile(deps, plan)) {
    ctx.emit({
      type: 'chunk',
      command: ctx.command,
      chunk: plan.runId,
      status: 'skipped',
      detail: 'committed by another exporter meanwhile',
    });

    return outcome('skipped', { docs: 0, note: 'committed by another exporter meanwhile' });
  }

  const before = await countSource(ctx, deps, plan, plan.hint);

  // The manifest records the hint the count ran under, which may be none when the server refused
  // the planned index.
  const recorded: ChunkPlan =
    before.hint === plan.hint
      ? plan
      : { ...plan, filterRecord: { ...plan.filterRecord, hint: before.hint } };

  const manifestFor = (
    exported: number,
    after: number,
    ids: { first: string | null; last: string | null },
    parts: PartRef[]
  ) =>
    buildChunkManifest({
      plan: recorded,
      partition: deps.layout.partition,
      sourceCount: before.count,
      sourceCountAfter: after,
      exported,
      firstId: ids.first,
      lastId: ids.last,
      parts,
      startedAt,
      completedAt: ctx.now(),
      toolVersion,
    });

  if (plan.paging === 'none') {
    // A manifest-only chunk records an empty collection. One that filled up meanwhile writes
    // nothing: a flagged manifest would stay behind once the resume plans the collection with a
    // real strategy.
    if (before.count > 0) {
      const note = `before 0, after ${formatCount(before.count)}, exported 0`;

      ctx.emit({
        type: 'chunk',
        command: ctx.command,
        chunk: plan.runId,
        status: 'mismatch',
        detail:
          `collection has ${formatCount(before.count)} documents now; rerun the ` +
          'batch to plan it with a strategy',
      });

      return outcome('mismatch', { docs: 0, code: 'count_mismatch', note });
    }

    await writeRecords(deps, plan, manifestFor(0, 0, { first: null, last: null }, []), null, null);

    ctx.emit({
      type: 'chunk',
      command: ctx.command,
      chunk: plan.runId,
      status: 'done',
      detail: 'empty collection, manifest only',
    });

    return outcome('done', { docs: 0 });
  }

  const dir = join(tempDirOf(config, 'export'), plan.runId);

  await rm(dir, { recursive: true, force: true });
  // In-flight documents are often personal data and tempDir may be a shared volume: owner-only all
  // the way down.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const writer = createPartWriter({
    dir,
    gzipLevel: config.export.gzipLevel,
    maxDocs: config.export.partMaxDocs,
    maxBytes: config.export.partMaxBytesMb * 1024 * 1024,
    minFreeMb: config.minFreeDiskMb,
  });

  const uploads = new AbortController();
  const onAbort = () => uploads.abort(ctx.signal.reason);

  ctx.signal.addEventListener('abort', onAbort, { once: true });

  const parts: PartRef[] = [];
  let inFlight: Promise<void> | null = null;
  const coll = deps.mongo.db.collection(plan.collection);

  const upload = (closed: ClosedPart | null) => {
    if (closed === null) return;

    inFlight = uploadPart(deps.store, deps.layout, plan, closed, uploads.signal).then(ref => {
      parts.push(ref);

      ctx.emit({
        type: 'chunk',
        command: ctx.command,
        chunk: plan.runId,
        status: 'part',
        detail: `${ref.name} ${formatCount(closed.lines)} lines, ${mb(ref.bytes)}`,
      });
    });

    // The failure surfaces where the promise is awaited; this tap only stops Node from reporting it
    // as unhandled meanwhile.
    inFlight.catch(() => undefined);
  };

  let exported = 0;
  let firstLine: string | null = null;
  let firstId: string | null = null;
  let lastId: string | null = null;
  let totalBytes = 0;

  try {
    // Nothing to read when the filter counted zero: the brackets would still be walked, and a rest
    // chunk's first `_id_` page reads the whole collection.
    const docs: AsyncGenerator<Document> | [] =
      before.count === 0
        ? []
        : plan.paging === 'keyset'
          ? streamKeyset(coll, plan, ctx)
          : streamCursor(coll, plan, ctx);

    for await (const doc of docs) {
      if (ctx.signal.aborted) throw msmError('interrupted', `${plan.runId}: interrupted`);

      const line = docToLine(doc);
      const id = idText(doc._id);

      if (firstId === null) {
        firstId = id;
        firstLine = line;
      }

      lastId = id;
      exported += 1;

      const closed = await writer.write(line);

      if (closed !== null) {
        if (inFlight !== null) await inFlight;

        upload(closed);
      }
    }

    const last = await writer.finish();

    if (inFlight !== null) await inFlight;

    upload(last);

    if (inFlight !== null) await inFlight;

    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Aborting the upload would not stop its HTTP requests: a PUT already in flight would finish
    // after the next attempt's own PUT and leave the earlier bytes under the new manifest's sha256.
    // So the upload is left to settle; only the run signal (wired above) aborts it.
    if (inFlight !== null) await (inFlight as Promise<void>).catch(() => undefined);

    await writer.abort();
    await rm(dir, { recursive: true, force: true });

    throw err;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }

  parts.sort((a, b) => a.name.localeCompare(b.name));

  for (const p of parts) totalBytes += p.bytes;

  const after = await countSource(ctx, deps, plan, before.hint);
  const match = before.count === after.count && after.count === exported;

  const note =
    `before ${formatCount(before.count)}, after ${formatCount(after.count)}, ` +
    `exported ${formatCount(exported)}`;

  if (!match && attempt < config.export.chunkAttempts) throw msmError('count_mismatch', note);

  const manifest = manifestFor(exported, after.count, { first: firstId, last: lastId }, parts);

  await writeRecords(deps, plan, manifest, firstLine, parts.length > 0 ? true : null);

  const seconds = ((ctx.now().getTime() - startedAt.getTime()) / 1000).toFixed(1);

  if (!match) {
    ctx.emit({
      type: 'chunk',
      command: ctx.command,
      chunk: plan.runId,
      status: 'mismatch',
      detail: `${note} (${seconds}s); load needs --allow-mismatch`,
    });

    return outcome('mismatch', { docs: exported, code: 'count_mismatch', note });
  }

  ctx.emit({
    type: 'chunk',
    command: ctx.command,
    chunk: plan.runId,
    status: 'done',
    detail: `${formatCount(exported)} docs, ${mb(totalBytes)} (${seconds}s)`,
  });

  return outcome('done', { docs: exported });
}
