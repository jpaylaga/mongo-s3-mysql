import formatCount from '../runtime/formatCount.js';
import type { ResolvedManifest, RunContext } from '../types.js';
import type { VerifyBatch } from './resolveBatches.js';

/**
 * Each batch manifest's `completed_chunks` against the committed chunk manifests found over every archived
 * collection, so a lost manifest is as loud as a damaged part. Skipped under `-C`: a narrowed selection
 * cannot be counted against the batch. Returns the ids that fall short.
 */
export default function checkCompleteness(ctx: RunContext, batches: VerifyBatch[], listed: ReadonlyMap<string, ResolvedManifest[]>, narrowed: boolean): string[] {
  if (narrowed) {
    ctx.emit({ type: 'info', command: ctx.command, message: 'batch completeness not checked: -C narrows the run to some collections' });
    return [];
  }
  const missing: string[] = [];
  for (const { id, batch } of batches) {
    if (batch === null) continue;
    const found = (listed.get(id) ?? []).filter((r) => r.manifest.counts_match).length;
    if (found < batch.completed_chunks) {
      missing.push(id);
      ctx.emit({ type: 'warn', command: ctx.command, message: `batch ${id}: ${formatCount(found)} of ${formatCount(batch.completed_chunks)} completed chunks have a manifest` });
    }
  }
  return missing;
}
