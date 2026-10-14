import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import exitCodes from '#cli/exitCodes';
import buildMapping from '#infer/buildMapping';
import collectPathStats from '#infer/collectPathStats';
import identifier from '#infer/identifier';
import sampleDocs from '#infer/sampleDocs';
import createLayout from '#layout/createLayout';
import discoverCollections from '#layout/discoverCollections';
import listBatchManifests from '#layout/listBatchManifests';
import listChunkManifests from '#layout/listChunkManifests';
import mappingSchema from '#mapping/mappingSchema';
import mappingToDdl from '#mapping/mappingToDdl';
import abortExitCode from '#runtime/abortExitCode';
import errorMessage from '#runtime/errorMessage';
import fileExists from '#runtime/fileExists';
import formatCount from '#runtime/formatCount';
import isMsmError from '#runtime/isMsmError';
import msmError from '#runtime/msmError';
import toolVersion from '#runtime/toolVersion';
import type { BatchManifest, InferOptions, InferResult, ResolvedManifest } from '#types';

/**
 * A batch's kind: the frozen plan says it, else the original exporter's `backup_mode`, else the
 * id's own `-delta-` segment.
 */
function batchKind(batch: BatchManifest): 'full' | 'delta' {
  if (batch.plan !== undefined) return batch.plan.kind;

  if (batch.backup_mode !== undefined) return /delta/i.test(batch.backup_mode) ? 'delta' : 'full';

  return /-delta-/.test(batch.run_id) ? 'delta' : 'full';
}

/**
 * The read failures one collection can have on its own: a part missing or misaddressed, a damaged
 * record, a line too deep for V8.
 */
const perCollectionFailure = (err: unknown): boolean =>
  (isMsmError(err) &&
    !err.fatal &&
    (err.msmCode === 'record' || err.msmCode === 's3' || err.msmCode === 'parse')) ||
  err instanceof RangeError;

/**
 * Samples each collection from the newest finished full batch that holds documents of it (so old
 * and new windows are both represented; a delta only holds the last windows), falling back to the
 * newest delta, or from `--batch-id`, and writes `<collection>.mapping.json` plus
 * `<collection>.sql` into `outDir`. A collection whose config names another `mapping` path is told
 * so: infer never writes over a file the config points at, since that is usually a curated mapping.
 * Nothing is written until every target path is known to be free, so a run that refuses one
 * existing file leaves no half-written set behind. A collection that cannot be mapped or read is
 * reported and the others continue; the run then exits 2. An interrupt returns the files written so
 * far with the signal's exit code. Reads S3 only.
 */
export default async function infer(options: InferOptions): Promise<InferResult> {
  const { ctx, store, outDir } = options;
  const { config } = ctx;
  const layout = createLayout(config.s3);
  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const info = (message: string) => ctx.emit({ type: 'info', command: ctx.command, message });

  const files: string[] = [];
  const review: InferResult['review'] = [];
  let failed = 0;

  let targets: { name: string; mapping: string; sql: string; configured: string | undefined }[] =
    [];

  const interrupted = (): InferResult => {
    warn(
      `infer interrupted after ${formatCount(files.length / 2)} of ` +
        `${formatCount(targets.length)} collections`
    );

    return { files, review, exitCode: abortExitCode(ctx.signal) };
  };

  // Every S3 read below (the listings included) throws `interrupted` once the signal is aborted;
  // that is a result, not a failure.
  try {
    const configured =
      options.collections.length > 0
        ? options.collections
        : (await discoverCollections(store, layout)).map(name => ({ name, mapping: undefined }));

    targets = configured.map(cc => ({
      name: cc.name,
      mapping: join(outDir, `${cc.name}.mapping.json`),
      sql: join(outDir, `${cc.name}.sql`),
      configured: cc.mapping,
    }));

    if (!options.force) {
      const present = (
        await Promise.all(
          targets
            .flatMap(t => [t.mapping, t.sql])
            .map(async p => ((await fileExists(p)) ? p : null))
        )
      ).filter((p): p is string => p !== null);

      if (present.length > 0)
        throw msmError(
          'config',
          `infer: ${present.join(', ')} already exist; pass --force to overwrite`,
          { fatal: true }
        );
    }

    // Full batches newest first, then deltas newest first; finished batches only (a running or
    // interrupted one may still be missing windows).
    let candidates: { id: string; kind: 'full' | 'delta' | 'named' }[];

    if (options.batchId !== undefined) candidates = [{ id: options.batchId, kind: 'named' }];
    else {
      const batches = (await listBatchManifests(store, layout)).filter(
        ({ batch }) => batch.status !== 'running' && batch.status !== 'interrupted'
      );

      if (batches.length === 0)
        throw msmError('config', 'infer: no batch manifest under the prefix; pass --batch-id', {
          fatal: true,
        });

      const newestFirst = batches
        .map(({ batch }) => ({ id: batch.run_id, kind: batchKind(batch) }))
        .reverse();

      candidates = [
        ...newestFirst.filter(b => b.kind === 'full'),
        ...newestFirst.filter(b => b.kind === 'delta'),
      ];
    }

    const sampleOf = async (
      name: string
    ): Promise<{ batchId: string; kind: string; manifests: ResolvedManifest[] } | null> => {
      for (const { id, kind } of candidates) {
        // One damaged manifest is skipped with a warning; the other chunks of the batch still make
        // a sample.
        const manifests = await listChunkManifests(store, layout, name, id, bad =>
          warn(
            `${name}: chunk manifest ${bad.key} does not parse and is left out of ` +
              `the sample (${bad.message.split('\n')[0] ?? ''}); run verify`
          )
        );

        if (manifests.some(m => m.parts.length > 0))
          return { batchId: id, kind: kind === 'named' ? 'named' : `${kind} batch`, manifests };
      }

      return null;
    };

    for (const target of targets) {
      if (ctx.signal.aborted) return interrupted();

      let found: Awaited<ReturnType<typeof sampleOf>>;
      let docs: Awaited<ReturnType<typeof sampleDocs>>;

      try {
        found = await sampleOf(target.name);
        docs = found === null ? [] : await sampleDocs(ctx, store, found.manifests, config.infer);
      } catch (err) {
        // A missing part or a damaged record of one collection must not take the others down: files
        // are written per collection as the loop goes.
        if (!perCollectionFailure(err)) throw err;

        warn(`${target.name}: ${errorMessage(err)}; no mapping written`);
        failed += 1;

        continue;
      }

      if (found === null) {
        const searched =
          options.batchId === undefined ? 'any finished batch' : `batch ${options.batchId}`;

        warn(`${target.name}: no documents in ${searched}; no mapping written`);

        failed += 1;

        continue;
      }

      const { batchId, kind, manifests } = found;

      if (docs.length === 0) {
        warn(`${target.name}: no documents to sample in batch ${batchId}; no mapping written`);
        failed += 1;

        continue;
      }

      info(
        `${target.name}: sampled ${formatCount(docs.length)} documents from ` +
          `${manifests.length} chunks of ` +
          `${batchId}${kind === 'named' ? '' : ` (${kind})`}`
      );

      let built: ReturnType<typeof buildMapping>;
      let stats: ReturnType<typeof collectPathStats>;

      try {
        stats = collectPathStats(docs);

        built = buildMapping(target.name, stats, {
          ...options.build,
          table: options.build.table ?? identifier(target.name),
          sampled: docs.length,
          toolVersion,
          now: ctx.now(),
        });
      } catch (err) {
        // A line nested past what V8's stack takes (a foreign or tampered archive) fails this
        // collection, not the run.
        if (!(err instanceof RangeError)) throw err;

        warn(
          `${target.name}: a sampled document is too deep or too large to analyse ` +
            `(${errorMessage(err)}); no mapping written`
        );

        failed += 1;

        continue;
      }

      if (built === null) {
        const seen =
          Object.entries(stats.find(s => s.path === '_id')?.types ?? {})
            .map(([type, count]) => `${type} ${count}`)
            .join(', ') || 'none';

        warn(
          `${target.name}: no key cast fits the sampled _id types (${seen}); no mapping written`
        );

        failed += 1;

        continue;
      }

      const parsed = mappingSchema.safeParse(built);

      if (!parsed.success) {
        warn(
          `${target.name}: the inferred mapping is invalid; no mapping ` +
            `written:\n${z.prettifyError(parsed.error)}`
        );

        failed += 1;

        continue;
      }

      const ddl = mappingToDdl(parsed.data, { keyLedger: config.load.keyLedger });

      await mkdir(outDir, { recursive: true });
      await writeFile(target.mapping, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
      await writeFile(target.sql, `${ddl.join('\n')}\n`, 'utf8');
      files.push(target.mapping, target.sql);

      const lines = built.inferred?.review ?? [];

      review.push({ collection: target.name, lines });

      for (const line of lines) warn(`${target.name}: ${line}`);

      info(`${target.name}: wrote ${target.mapping} and ${target.sql}`);

      if (
        target.configured !== undefined &&
        resolve(target.configured) !== resolve(target.mapping)
      ) {
        warn(
          `${target.name}: the config reads collections[].mapping ` +
            `${target.configured}; copy the new file there or point mapping at it ` +
            'before load'
        );
      }
    }
  } catch (err) {
    if (isMsmError(err, 'interrupted') || ctx.signal.aborted) return interrupted();

    throw err;
  }

  if (ctx.signal.aborted) return interrupted();

  return { files, review, exitCode: failed > 0 ? exitCodes.incomplete : exitCodes.ok };
}
