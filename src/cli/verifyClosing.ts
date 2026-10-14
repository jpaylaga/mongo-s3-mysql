import type { VerifyResult } from '../types.js';
import isInterrupted from './isInterrupted.js';
import nextCommand, { type NextGlobals } from './nextCommand.js';

/**
 * Damaged chunks, missing manifests and damaged batch manifests need different repairs: a committed chunk is
 * never rewritten by export, so a damaged part is restored from versioning or exported again under a new
 * batch; a missing chunk manifest is rewritten by resuming the batch, when this tool wrote it; a batch
 * manifest that does not parse cannot be resumed at all (export reads it first), so only versioning restores it.
 */
export default function verifyClosing(result: VerifyResult, dryRun: boolean | undefined, globals: NextGlobals = {}): string {
  if (dryRun) return 'run without --dry-run to read the parts';
  const damaged = result.checks.filter((c) => !c.ok && c.operational === undefined);
  if (damaged.length > 0 || result.missing.length > 0 || result.invalidBatches.length > 0) {
    const parts: string[] = [];
    if (damaged.length > 0) {
      const batches = new Set(damaged.map((c) => c.batchId)).size;
      parts.push(`${damaged.length} damaged chunks in ${batches} batch${batches === 1 ? '' : 'es'}: restore the objects from bucket versioning, or export those collections again under a new batch id (a committed chunk is never rewritten); the errors are in each parse-check.json`);
    }
    if (result.missing.length > 0) {
      // export takes one --batch-id at a time, so several batches get the template and the list, one batch gets its own command.
      const shown = result.missing.slice(0, 3).join(', ') + (result.missing.length > 3 ? ', ...' : '');
      const command = result.missing.length === 1 ? `${nextCommand(globals, 'export', ['--batch-id', result.missing[0] as string])} rewrites them` : `${nextCommand(globals, 'export', ['--batch-id', '<id>'])} for each of ${shown} rewrites them`;
      parts.push(`${result.missing.length} batch${result.missing.length === 1 ? ' is' : 'es are'} missing chunk manifests: ${command} for a batch this tool wrote; another exporter's batch needs a new export`);
    }
    if (result.invalidBatches.length > 0) {
      const shown = result.invalidBatches.slice(0, 3).join(', ') + (result.invalidBatches.length > 3 ? ', ...' : '');
      parts.push(`batch manifest${result.invalidBatches.length === 1 ? '' : 's'} ${shown} ${result.invalidBatches.length === 1 ? 'is' : 'are'} damaged: restore ${result.invalidBatches.length === 1 ? 'it' : 'them'} from bucket versioning (export cannot resume a batch whose manifest does not parse)`);
    }
    return parts.join('; ');
  }
  if (result.checks.some((c) => c.operational !== undefined)) return `${nextCommand(globals, 'verify')} again for the chunks that could not be read`;
  if (isInterrupted(result.exitCode)) return `${nextCommand(globals, 'verify')} again to continue`;
  return `${nextCommand(globals, 'infer')}, then ${nextCommand(globals, 'load')}`;
}
