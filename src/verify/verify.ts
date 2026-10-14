import exitCodes from '../cli/exitCodes.js';
import buildValidation from '../export/buildValidation.js';
import createLayout from '../layout/createLayout.js';
import discoverCollections from '../layout/discoverCollections.js';
import abortExitCode from '../runtime/abortExitCode.js';
import acquireLock from '../runtime/acquireLock.js';
import formatBytes from '../runtime/formatBytes.js';
import formatCount from '../runtime/formatCount.js';
import isMsmError from '../runtime/isMsmError.js';
import mapLimit from '../runtime/mapLimit.js';
import msmError from '../runtime/msmError.js';
import runChunkAttempts from '../runtime/runChunkAttempts.js';
import type { ChunkCheck, ChunkOutcome, ExitCode, ResolvedManifest, VerifyOptions, VerifyResult } from '../types.js';
import checkCompleteness from './checkCompleteness.js';
import listManifests from './listManifests.js';
import pendingChunks from './pendingChunks.js';
import resolveBatches from './resolveBatches.js';
import verifyChunk from './verifyChunk.js';
import writeChecks from './writeChecks.js';

// Verify has no chunkAttempts setting: a chunk attempt only fails on an S3 read that withRetry gave up on.
const chunkAttempts = 3;

const exitFor = (signal: AbortSignal, outcomes: ChunkOutcome[], checks: ChunkCheck[], missing: string[], invalidBatches: string[]): ExitCode => {
  if (outcomes.some((o) => o.status === 'interrupted')) return abortExitCode(signal);
  if (missing.length > 0 || invalidBatches.length > 0 || checks.some((c) => !c.ok && c.operational === undefined)) return exitCodes.invalid;
  if (checks.some((c) => c.operational !== undefined)) return exitCodes.incomplete;
  return exitCodes.ok;
};

/** A chunk whose read failed operationally keeps the exporter's record values, so the result still describes it. */
const operationalCheck = (resolved: ResolvedManifest, outcome: ChunkOutcome): ChunkCheck => {
  const { counts, parseCheck } = buildValidation(resolved.manifest, null, null);
  return { runId: resolved.runId, batchId: resolved.batchId, collection: resolved.collection, ok: false, lines: 0, errors: [], operational: outcome.error ?? outcome.status, counts, parseCheck };
};

/**
 * Re-reads archived chunks and rewrites their validation records: lock, resolve the batches, list their
 * manifests, keep the chunks without a passing parse-check for their current manifest (`--all` keeps every
 * one), confirm, read, check each batch's completeness, assemble the result. A manifest that does not parse
 * is one damaged chunk, not the end of the run; a batch manifest that does not parse is reported on its own,
 * since export cannot resume such a batch. A `--batch-id` or `-C` that names nothing under the prefix is a
 * config error, so a scripted gate cannot pass on a typo.
 */
export default async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const { ctx, store } = options;
  const { config } = ctx;
  const layout = createLayout(config.s3);
  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const info = (message: string) => ctx.emit({ type: 'info', command: ctx.command, message });
  const narrowed = options.narrowed ?? false;
  const release = await acquireLock(config.stateDir, 'verify', options.forceUnlock ?? false, warn);
  try {
    const discovered = await discoverCollections(store, layout);
    const selected = options.collections.length > 0 ? options.collections.map((c) => c.name) : discovered;
    const unknown = selected.filter((name) => !discovered.includes(name));
    if (narrowed && unknown.length > 0) throw msmError('config', `-C ${unknown.join(', ')}: no such collection under s3://${layout.bucket}/${config.s3.prefix}`, { fatal: true });
    // The batch tally covers every archived collection, so manifests outside the selection are listed (not read) for the count.
    const counted = narrowed ? selected : [...new Set([...selected, ...discovered])];

    const requested = options.batchIds !== undefined && options.batchIds.length > 0;
    const { batches, invalid: invalidBatches } = await resolveBatches(ctx, store, layout, options.batchIds);
    const { listed, invalid, damagedBatches } = await listManifests(ctx, store, layout, batches, counted, selected);
    for (const { id, batch } of batches) {
      if (batch !== null || invalidBatches.includes(id)) continue;
      if (requested && (listed.get(id)?.length ?? 0) === 0 && !damagedBatches.has(id)) throw msmError('config', `batch ${id} not found under s3://${layout.bucket}/${config.s3.prefix}: no batch manifest and no chunk manifest`, { fatal: true });
      warn(`batch ${id} has no batch manifest; its completeness cannot be checked`);
    }
    const manifests = [...listed.values()].flat().filter((r) => selected.includes(r.collection));
    const toVerify = await pendingChunks(store, layout, manifests, options.all ?? false);
    const skipped = manifests.length - toVerify.length;
    const write = (checks: ChunkCheck[]) => (options.write === false ? Promise.resolve() : writeChecks(store, layout, checks));

    const objects = toVerify.reduce((sum, r) => sum + r.parts.length + r.parts.filter((p) => p.checksum_s3_uri !== null).length, 0);
    const bytes = toVerify.reduce((sum, r) => sum + r.parts.reduce((s, p) => s + p.bytes, 0), 0);
    const question = `Read ${formatBytes(bytes)} in ${formatCount(objects)} objects to verify ${formatCount(toVerify.length)} chunks?`;
    if (options.dryRun) {
      info(`dry run: ${question.slice(0, -1)}; ${formatCount(skipped)} already verified, ${formatCount(batches.length)} batches, ${formatCount(selected.length)} collections`);
      return { checks: [], skipped, missing: [], invalidBatches: [], exitCode: exitCodes.ok };
    }
    for (const check of invalid) ctx.emit({ type: 'chunk', command: ctx.command, chunk: check.runId, status: 'mismatch', detail: check.errors.join('; ') });
    // Nothing is written before the prompt: a declined run leaves the archive as it was, damaged records included.
    if (toVerify.length === 0) {
      if (invalid.length > 0 && options.confirm) await options.confirm(`Nothing to read; write a failing parse-check for ${formatCount(invalid.length)} damaged manifests?`);
      await write(invalid);
      info(`nothing to verify: ${formatCount(skipped)} chunks already verified`);
      const missing = checkCompleteness(ctx, batches, listed, narrowed);
      return { checks: invalid, skipped, missing, invalidBatches, exitCode: exitFor(ctx.signal, [], invalid, missing, invalidBatches) };
    }
    if (options.confirm) await options.confirm(question);
    await write(invalid);

    const checks = new Map<string, ChunkCheck>();
    let done = 0;
    let docs = 0;
    const outcomes = await mapLimit(toVerify, config.verify.concurrency, (resolved) =>
      runChunkAttempts(ctx, { chunk: resolved.runId, collection: resolved.collection }, chunkAttempts, async () => {
        ctx.emit({ type: 'chunk', command: ctx.command, chunk: resolved.runId, status: 'start' });
        const startedAt = Date.now();
        const check = await verifyChunk(ctx, store, layout, resolved);
        await write([check]);
        checks.set(resolved.runId, check);
        done += 1;
        docs += check.lines;
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        ctx.emit({ type: 'chunk', command: ctx.command, chunk: resolved.runId, status: check.ok ? 'done' : 'mismatch',
          detail: check.ok ? `${formatCount(check.lines)} lines (${seconds}s)` : check.errors.slice(0, 3).join('; ') });
        ctx.emit({ type: 'progress', command: ctx.command, done, total: toVerify.length, docs });
        return { chunk: resolved.runId, collection: resolved.collection, status: check.ok ? 'done' : 'mismatch', docs: check.lines };
      }));

    const results: ChunkCheck[] = [...invalid, ...outcomes.map((outcome, i) => {
      const resolved = toVerify[i] as ResolvedManifest;
      return checks.get(resolved.runId) ?? operationalCheck(resolved, outcome);
    })];
    const missing = checkCompleteness(ctx, batches, listed, narrowed);
    return { checks: results, skipped, missing, invalidBatches, exitCode: exitFor(ctx.signal, outcomes, results, missing, invalidBatches) };
  } catch (err) {
    // The listings and record reads throw `interrupted` once the signal is aborted (the chunk phase turns it into outcomes itself).
    if (isMsmError(err, 'interrupted') || ctx.signal.aborted) {
      warn('verify interrupted before any chunk was read');
      return { checks: [], skipped: 0, missing: [], invalidBatches: [], exitCode: abortExitCode(ctx.signal) };
    }
    throw err;
  } finally {
    await release();
  }
}
