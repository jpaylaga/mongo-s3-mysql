import exitCodes from '#cli/exitCodes';
import bareCollection from '#config/bareCollection';
import createExportLedger from '#export/createExportLedger';
import exportChunk from '#export/exportChunk';
import planChunks from '#export/planChunks';
import resolveBatch from '#export/resolveBatch';
import writeBatchManifest from '#export/writeBatchManifest';
import createLayout from '#layout/createLayout';
import parseChunkRunId from '#layout/parseChunkRunId';
import readRecord from '#layout/readRecord';
import recordSchemas from '#layout/recordSchemas';
import abortExitCode from '#runtime/abortExitCode';
import acquireLock from '#runtime/acquireLock';
import checkFreeSpace from '#runtime/checkFreeSpace';
import errorMessage from '#runtime/errorMessage';
import formatCount from '#runtime/formatCount';
import formatUtc from '#runtime/formatUtc';
import mapLimit from '#runtime/mapLimit';
import msmError from '#runtime/msmError';
import prepareTempDir from '#runtime/prepareTempDir';
import redact from '#runtime/redact';
import runChunkAttempts from '#runtime/runChunkAttempts';
import type {
  BatchPlan,
  BatchStatus,
  ChunkOutcome,
  ChunkPlan,
  CollectionConfig,
  ExportDeps,
  ExportOptions,
  ExportResult,
  ExportSources,
  RunContext,
} from '#types';

/**
 * Chunks already committed for this batch, from the manifests S3 lists: a listed manifest the local
 * cache knows under the same key and bucket is done without a read, any other listed manifest is
 * read and done only when `counts_match` is true (then cached). The cache never adds a chunk the
 * listing lacks, so a cleaned prefix or another bucket plans everything again, and a flagged
 * manifest is pending.
 */
async function committedChunks(
  ctx: RunContext,
  deps: ExportDeps,
  batch: BatchPlan,
  collections: string[]
): Promise<Set<string>> {
  const cached = await deps.ledger.read();
  const done = new Set<string>();

  for (const collection of collections) {
    const { keys } = await deps.store.list(
      deps.layout.chunkManifestPrefix(collection, batch.batchId)
    );

    for (const key of keys) {
      const file = key.slice(key.lastIndexOf('/') + 1);

      if (!file.startsWith('run_id=') || !file.endsWith('.json')) continue;

      const runId = file.slice('run_id='.length, -'.json'.length);

      if (parseChunkRunId(runId, batch.batchId, collection) === null) continue;

      // The commit is the manifest at its canonical key (I1); a copy nested deeper under the prefix
      // is not one.
      if (key !== deps.layout.chunkManifest(collection, runId)) continue;

      const entry = cached.get(runId);

      if (
        entry !== undefined &&
        entry.manifest_key === key &&
        entry.bucket === deps.layout.bucket
      ) {
        done.add(runId);

        continue;
      }

      const record = await readRecord(deps.store, key, recordSchemas.chunkManifest);

      if (record === null || !record.value.counts_match) continue;

      done.add(runId);

      await deps.ledger.append(runId, {
        manifest_key: key,
        bucket: deps.layout.bucket,
        manifest_sha256: record.sha256,
        exported_count: record.value.exported_count,
      });
    }
  }

  if (done.size > 0)
    ctx.emit({
      type: 'info',
      command: ctx.command,
      message: `batch ${batch.batchId}: ${formatCount(done.size)} chunks already committed`,
    });

  return done;
}

/**
 * A signal that lands after the last chunk committed changes nothing: the batch is complete and
 * `--since last` may build on it.
 */
const finalStatus = (
  ctx: RunContext,
  planned: number,
  completed: number,
  fatal: boolean
): BatchStatus => {
  if (fatal) return 'failed';

  if (completed === planned) return 'complete';

  return ctx.signal.aborted ? 'interrupted' : 'partial';
};

/**
 * The export orchestration: lock, plan, find what is already committed, confirm, write the running
 * batch manifest, run the pending chunks with bounded concurrency, and rewrite the batch manifest
 * whatever happened. The whole frozen plan is planned on every invocation so the tally covers the
 * batch; `-C` only narrows which pending chunks run, and a batch with chunks still pending outside
 * the selection stays `partial`. Chunks share one abort signal: the run's own plus a local one that
 * a fatal error pulls, so the other chunks stop between documents instead of racing on.
 */
export default async function exportArchive(options: ExportOptions): Promise<ExportResult> {
  const { ctx, mongo, store, collections } = options;
  const { config } = ctx;

  if (collections.length === 0)
    throw msmError(
      'config',
      'config: no collections to export; run inventory --write-config or pass -C',
      { fatal: true }
    );

  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const info = (message: string) => ctx.emit({ type: 'info', command: ctx.command, message });

  const releaseLock = await acquireLock(
    config.stateDir,
    'export',
    options.forceUnlock ?? false,
    warn
  );

  try {
    // Parts hold the documents themselves; a shared tempDir volume must neither expose them nor let
    // another user plant paths.
    const tempDir = await prepareTempDir(config, 'export');

    (await checkFreeSpace(tempDir, config.minFreeDiskMb))();

    const layout = createLayout(config.s3);
    const sources: ExportSources = { mongo, store, layout };
    let deps: ExportDeps;

    const interrupted = (batchId: string): ExportResult => {
      warn(
        `${batchId === '' ? 'export' : `batch ${batchId}`} interrupted before any ` +
          'chunk ran; nothing was written'
      );

      return {
        batchId,
        status: 'interrupted',
        outcomes: [],
        perCollection: [],
        exitCode: abortExitCode(ctx.signal),
      };
    };

    let batch: BatchPlan;
    // The id a new batch was given, so an interrupt during planning names it even though `batch` is
    // not usable yet.
    let batchId = options.batchId ?? '';
    const plans: ChunkPlan[] = [];
    let done: Set<string>;
    const selected = new Set(collections.map(c => c.name));

    try {
      batch = await resolveBatch(ctx, sources, options);
      batchId = batch.batchId;
      deps = { ...sources, ledger: createExportLedger(config.stateDir, batch.batchId) };

      info(
        `${batch.resumed ? 'resuming' : 'starting'} ${batch.kind} batch ` +
          `${batch.batchId}, cutoff ${batch.cutoff.toISOString()}`
      );

      for (const cc of collections) {
        if (!batch.collections.some(p => p.collection === cc.name))
          throw msmError('config', `${cc.name} is not in the plan of batch ${batch.batchId}`, {
            fatal: true,
          });
      }

      // Every collection of the frozen plan is planned, selected or not, so the tally describes the
      // batch.
      const ccFor = (planned: BatchPlan['collections'][number]): CollectionConfig =>
        collections.find(c => c.name === planned.collection) ??
        config.collections.find(c => c.name === planned.collection) ??
        bareCollection(planned.collection, planned.window ?? 'day');

      for (const planned of batch.collections) {
        const { chunks, outOfRange, start } = await planChunks(ctx, sources, batch, ccFor(planned));

        plans.push(...chunks);

        if (outOfRange !== null) batch.outOfRange[planned.collection] = outOfRange;

        // A new batch freezes the start it derived from the data, so every resume plans the same
        // windows.
        if (!batch.resumed && planned.start_utc === null && start !== null)
          planned.start_utc = formatUtc(start, 'z');
      }

      done = await committedChunks(
        ctx,
        deps,
        batch,
        batch.collections.map(c => c.collection)
      );
    } catch (err) {
      if (ctx.signal.aborted) return interrupted(batchId);

      throw err;
    }

    const names = batch.collections.map(c => c.collection);
    const pending = plans.filter(p => selected.has(p.collection) && !done.has(p.runId));
    const unselected = plans.filter(p => !selected.has(p.collection) && !done.has(p.runId));

    if (unselected.length > 0)
      info(
        `batch ${batch.batchId}: ${formatCount(unselected.length)} pending chunks ` +
          'of unselected collections ' +
          `(${[...new Set(unselected.map(p => p.collection))].join(', ')}) are not ` +
          'run this time'
      );

    const perCollection = (outcomes: ChunkOutcome[]): ExportResult['perCollection'] =>
      names.map(name => {
        const mine = plans.filter(p => p.collection === name);
        const own = outcomes.filter(o => o.collection === name);

        return {
          collection: name,
          planned: mine.length,
          done:
            mine.filter(p => done.has(p.runId)).length +
            own.filter(o => o.status === 'done' || o.status === 'skipped').length,
          flagged: own.filter(o => o.status === 'mismatch').length,
          failed: own.filter(o => o.status === 'failed' || o.status === 'interrupted').length,
          docs: own.reduce((sum, o) => sum + (o.docs ?? 0), 0),
        };
      });

    if (options.dryRun) {
      for (const p of plans)
        info(
          `${done.has(p.runId) ? 'done   ' : selected.has(p.collection) ? 'pending' : 'skip   '}` +
            ` ${p.runId}`
        );

      info(
        `dry run: ${formatCount(plans.length)} chunks ` +
          `(${formatCount(pending.length)} pending) of ${formatCount(names.length)} ` +
          'collections; nothing written'
      );

      return {
        batchId: batch.batchId,
        status: 'planned',
        outcomes: [],
        perCollection: perCollection([]),
        exitCode: exitCodes.ok,
      };
    }

    const tally = {
      completed: plans.filter(p => done.has(p.runId)).length,
      failed: 0,
      notes: config.export.notes,
    };

    tally.failed = plans.length - tally.completed;

    if (pending.length > 0) {
      if (ctx.signal.aborted) return interrupted(batch.batchId);

      const target = `s3://${layout.bucket}/${config.s3.prefix}`;

      await options.confirm?.(
        `Export ${formatCount(plans.length)} chunks (${formatCount(pending.length)}` +
          ` pending) of ${formatCount(names.length)} collections from ` +
          `${config.mongo.database} to ${target} as batch ${batch.batchId}?`
      );

      if (ctx.signal.aborted) return interrupted(batch.batchId);

      await writeBatchManifest(deps, batch, 'running', { ...tally, now: ctx.now() });
    }

    const local = new AbortController();
    const chunkCtx: RunContext = { ...ctx, signal: AbortSignal.any([ctx.signal, local.signal]) };
    const outcomes: ChunkOutcome[] = [];
    let fatal: unknown = null;
    let docs = 0;

    try {
      await mapLimit(pending, config.export.concurrency, async plan => {
        let outcome: ChunkOutcome;

        try {
          outcome = await runChunkAttempts(
            chunkCtx,
            { chunk: plan.runId, collection: plan.collection },
            config.export.chunkAttempts,
            attempt => exportChunk(chunkCtx, deps, plan, attempt)
          );
        } catch (err) {
          fatal ??= err;
          local.abort(err);

          throw err;
        }

        outcomes.push(outcome);
        docs += outcome.docs ?? 0;

        if (outcome.status === 'done' || outcome.status === 'skipped') tally.completed += 1;

        if (outcome.status === 'failed')
          warn(`${plan.runId} failed (${outcome.code}): ${outcome.error ?? ''}`);

        ctx.emit({
          type: 'progress',
          command: ctx.command,
          done: outcomes.length,
          total: pending.length,
          docs,
        });
      });
    } catch (err) {
      fatal ??= err;
    }

    tally.failed = Math.max(0, plans.length - tally.completed);

    const status = finalStatus(ctx, plans.length, tally.completed, fatal !== null);

    try {
      await writeBatchManifest(deps, batch, status, { ...tally, now: ctx.now() });
    } catch (err) {
      // The store may refuse writes once the run signal is pulled; the next resume rewrites the
      // manifest.
      warn(
        `batch manifest not updated (${redact(errorMessage(err), ctx.secrets)}); ` +
          `the next run with --batch-id ${batch.batchId} rewrites it`
      );
    }

    if (fatal !== null) throw fatal;

    const exitCode = ctx.signal.aborted
      ? abortExitCode(ctx.signal)
      : status === 'complete'
        ? exitCodes.ok
        : exitCodes.incomplete;

    info(
      `batch ${batch.batchId} ${status}: ${formatCount(tally.completed)} of ` +
        `${formatCount(plans.length)} chunks committed, ${formatCount(docs)} docs ` +
        'this run'
    );

    return {
      batchId: batch.batchId,
      status,
      outcomes,
      perCollection: perCollection(outcomes),
      exitCode,
    };
  } finally {
    await releaseLock();
  }
}
