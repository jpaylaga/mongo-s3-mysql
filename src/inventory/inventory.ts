import exitCodes from '#cli/exitCodes';
import inventoryCollection from '#inventory/inventoryCollection';
import abortExitCode from '#runtime/abortExitCode';
import classifyError from '#runtime/classifyError';
import errorMessage from '#runtime/errorMessage';
import isMsmError from '#runtime/isMsmError';
import mapLimit from '#runtime/mapLimit';
import redact from '#runtime/redact';
import withRetry from '#runtime/withRetry';
import type { CollectionInventory, InventoryOptions, InventoryReport } from '#types';

/**
 * Enough to see mixed `_id` types and a missing date field without reading a busy collection for
 * long.
 */
const defaultSampleSize = 1000;

/**
 * Read-only look at the source: which collections exist, how big they are and which export strategy
 * fits each. A collection that fails for a non-fatal reason is skipped so the others still report.
 * A signal is a result with the collections read so far and the signal's exit code, like every
 * other command.
 */
export default async function inventory(options: InventoryOptions): Promise<InventoryReport> {
  const { ctx, mongo } = options;
  const sampleSize = options.sampleSize ?? defaultSampleSize;
  const done: CollectionInventory[] = [];
  const reasons = new Map<string, string>();
  const names: string[] = [];

  const interrupted = (): InventoryReport => ({
    collections: done,
    skipped: names
      .filter(name => reasons.has(name))
      .map(name => ({ name, reason: reasons.get(name) as string })),
    exitCode: abortExitCode(ctx.signal),
  });

  let listed: { name: string; type?: string }[];

  try {
    listed = await withRetry(ctx, { source: 'mongo', name: 'listCollections' }, () =>
      mongo.db.listCollections().toArray()
    );
  } catch (err) {
    if (isMsmError(err, 'interrupted') || ctx.signal.aborted) return interrupted();

    throw err;
  }

  const types = new Map(listed.map(c => [c.name, c.type ?? 'collection']));
  const everything = [...types.keys()].sort();
  const configured = ctx.config.collections.map(c => c.name);

  names.push(
    ...(options.names && options.names.length > 0
      ? options.names
      : options.all || configured.length === 0
        ? everything
        : configured)
  );

  const eligible = names.filter(name => {
    const type = types.get(name);

    if (type === undefined) reasons.set(name, 'not found');
    else if (name.startsWith('system.')) reasons.set(name, 'system collection');
    else if (type !== 'collection') reasons.set(name, `${type} is not exportable`);

    return !reasons.has(name);
  });

  let failed = 0;
  let results: (CollectionInventory | null)[];

  try {
    results = await mapLimit(eligible, 2, async (name): Promise<CollectionInventory | null> => {
      try {
        const facts = await inventoryCollection(ctx, mongo.db, name, sampleSize);

        done.push(facts);

        return facts;
      } catch (err) {
        const klass = classifyError(err);

        if (klass.fatal || klass.aborted) throw err;

        const message = redact(errorMessage(err), ctx.secrets);

        ctx.emit({
          type: 'warn',
          command: ctx.command,
          message: `${name}: skipped (${klass.code}): ${message}`,
        });

        reasons.set(name, message);
        failed += 1;

        return null;
      }
    });
  } catch (err) {
    if (isMsmError(err, 'interrupted') || classifyError(err).aborted || ctx.signal.aborted)
      return interrupted();

    throw err;
  }

  const exitCode = ctx.signal.aborted
    ? abortExitCode(ctx.signal)
    : failed > 0
      ? exitCodes.incomplete
      : exitCodes.ok;

  return {
    collections: results.filter((r): r is CollectionInventory => r !== null),
    skipped: names
      .filter(name => reasons.has(name))
      .map(name => ({ name, reason: reasons.get(name) as string })),
    exitCode,
  };
}
