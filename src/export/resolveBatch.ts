import instantSchema from '#config/instantSchema';
import listBatchManifests from '#layout/listBatchManifests';
import parseChunkRunId from '#layout/parseChunkRunId';
import readRecord from '#layout/readRecord';
import recordSchemas from '#layout/recordSchemas';
import durations from '#runtime/durations';
import floorTo from '#runtime/floorTo';
import formatCount from '#runtime/formatCount';
import formatUtc from '#runtime/formatUtc';
import msmError from '#runtime/msmError';
import smallCollectionDocs from '#runtime/smallCollectionDocs';
import withRetry from '#runtime/withRetry';
import type {
  BatchManifest,
  BatchPlan,
  CollectionConfig,
  ExportOptions,
  ExportSources,
  PlannedCollection,
  RunContext,
} from '#types';

const batchIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const config = (message: string) => msmError('config', message, { fatal: true });

const parseInstant = (text: string, what: string): Date => {
  if (!instantSchema.safeParse(text).success)
    throw config(
      `${what}: not an ISO 8601 instant with an offset at second precision (like ` +
        `2026-10-12T00:00:00Z): ${text}`
    );

  return new Date(text);
};

/** Foreign batches have no `status`; theirs is complete when it finished with nothing failed. */
const isComplete = (b: BatchManifest): boolean =>
  b.status === undefined
    ? b.completed_at !== null && b.failed_chunks === 0
    : b.status === 'complete';

/**
 * `out_of_range` as a prototype-free map, so a collection name can never read or write
 * Object.prototype.
 */
const outOfRangeOf = (record: BatchManifest): BatchPlan['outOfRange'] =>
  Object.assign(Object.create(null) as BatchPlan['outOfRange'], record.out_of_range ?? {});

/**
 * A resumed batch keeps its frozen plan. `--since last` is accepted as a no-op (the unit file that
 * started the delta restarts with the same line), and an explicit `--since` or `--cutoff` only when
 * it equals the frozen value, so a restart loop never fails on the flags that started the batch.
 */
function fromFrozenPlan(
  ctx: RunContext,
  key: string,
  record: BatchManifest,
  options: ExportOptions & { batchId: string }
): BatchPlan {
  if (record.plan === undefined || record.started_at === undefined)
    throw config(`batch ${options.batchId} was not written by this tool (${key} has no plan)`);

  if (record.run_id !== options.batchId)
    throw config(
      `batch ${options.batchId}: ${key} carries run_id ${JSON.stringify(record.run_id)}`
    );

  const cutoff = parseInstant(record.cutoff_utc, 'cutoff_utc');

  const since =
    record.requested_start_utc === undefined
      ? null
      : parseInstant(record.requested_start_utc, 'requested_start_utc');

  if (
    options.cutoff !== undefined &&
    parseInstant(options.cutoff, '--cutoff').getTime() !== cutoff.getTime()
  ) {
    throw config(
      `batch ${options.batchId} exists with cutoff ${record.cutoff_utc}; --cutoff ` +
        `${options.cutoff} does not match the frozen plan`
    );
  }

  if (options.since !== undefined) {
    if (record.plan.kind !== 'delta')
      throw config(
        `batch ${options.batchId} exists as a full batch; --since only applies to a delta`
      );

    if (options.since === 'last')
      ctx.emit({
        type: 'info',
        command: ctx.command,
        message:
          `batch ${options.batchId} exists; --since last is ignored in favour of its ` +
          'frozen plan',
      });
    else if (
      since === null ||
      parseInstant(options.since, '--since').getTime() !== since.getTime()
    ) {
      throw config(
        `batch ${options.batchId} exists with requested_start_utc ` +
          `${record.requested_start_utc ?? 'none'}; --since ${options.since} does ` +
          'not match the frozen plan'
      );
    }
  }

  return {
    batchId: options.batchId,
    kind: record.plan.kind,
    cutoff,
    since,
    startedAt: parseInstant(record.started_at, 'started_at'),
    collections: record.plan.collections.map(c => ({
      collection: c.collection,
      mode: c.mode,
      field: c.field,
      window: c.window,
      start_utc: c.start_utc,
      rest: c.rest,
    })),
    includeRest: record.plan.include_rest,
    resumed: true,
    outOfRange: outOfRangeOf(record),
  };
}

/**
 * Whether a batch without a frozen plan (another exporter's) archived `name`: it did when a chunk
 * manifest of that batch exists for the collection, or when a delta names it in
 * `collection_start_utc`. Assuming coverage would give a collection that exporter never touched a
 * delta start that skips all of its history.
 */
async function foreignCovers(
  deps: ExportSources,
  batch: BatchManifest,
  name: string
): Promise<boolean> {
  if (batch.collection_start_utc !== undefined && Object.hasOwn(batch.collection_start_utc, name))
    return true;

  const { keys } = await deps.store.list(deps.layout.chunkManifestPrefix(name, batch.run_id));

  return keys.some(key => {
    const file = key.slice(key.lastIndexOf('/') + 1);

    if (!file.startsWith('run_id=') || !file.endsWith('.json')) return false;

    const runId = file.slice('run_id='.length, -'.json'.length);

    // Only a manifest at its canonical key is a commit; a copy nested deeper under the prefix is
    // not one.
    return (
      key === deps.layout.chunkManifest(name, runId) &&
      parseChunkRunId(runId, batch.run_id, name) !== null
    );
  });
}

/**
 * `--since last` per collection: the newest complete batch that covers that collection, minus the
 * overlap. A batch with a frozen plan covers what the plan names; one without a plan (another
 * exporter) covers what the archive shows it exported. A collection no complete batch covers has no
 * safe delta start, so the run refuses rather than skip its history.
 */
async function sinceLast(
  ctx: RunContext,
  deps: ExportSources,
  names: string[]
): Promise<{ perCollection: Map<string, Date>; newest: Date }> {
  const batches = await listBatchManifests(deps.store, deps.layout);
  const complete = batches.filter(b => isComplete(b.batch)).reverse();
  const newest = complete[0];

  if (newest === undefined)
    throw config('--since last: no complete batch to continue from; run a full export first');

  const overlapMs = ctx.config.export.deltaOverlapMinutes * 60_000;

  const sinceOf = (b: typeof newest) =>
    new Date(parseInstant(b.batch.cutoff_utc, `${b.key} cutoff_utc`).getTime() - overlapMs);

  const covers = async (b: typeof newest, name: string): Promise<boolean> =>
    b.batch.plan === undefined
      ? foreignCovers(deps, b.batch, name)
      : b.batch.plan.collections.some(c => c.collection === name);

  const perCollection = new Map<string, Date>();

  for (const name of names) {
    let covering: typeof newest | undefined;

    for (const b of complete) {
      if (await covers(b, name)) {
        covering = b;

        break;
      }
    }

    if (covering === undefined)
      throw config(`--since last: no complete batch covers ${name}; run a full export of it first`);

    perCollection.set(name, sinceOf(covering));

    ctx.emit({
      type: 'info',
      command: ctx.command,
      message:
        `${name}: delta from ${covering.batch.run_id} (cutoff ` +
        `${covering.batch.cutoff_utc}, minus ${ctx.config.export.deltaOverlapMinutes}` +
        ' min overlap)',
    });
  }

  return { perCollection, newest: sinceOf(newest) };
}

/**
 * The rest chunk is planned here, not in planChunks, because the decision is frozen into the batch
 * manifest: `auto` exports it only when the collection is small enough for one keyset walk.
 */
async function wantsRest(
  ctx: RunContext,
  deps: ExportSources,
  cc: CollectionConfig,
  kind: 'full' | 'delta',
  includeRest: boolean
): Promise<boolean> {
  if (includeRest) return true;

  if (kind === 'delta' || cc.rest === 'skip') {
    ctx.emit({
      type: 'warn',
      command: ctx.command,
      message:
        `${cc.name}: rest chunk skipped ` +
        `(${kind === 'delta' ? 'delta batch' : 'rest: skip'}); pass --include-rest ` +
        'to export documents outside the windows',
    });

    return false;
  }

  if (cc.rest === 'export') return true;

  const estimated = Number(
    await withRetry(ctx, { source: 'mongo', name: `estimatedDocumentCount ${cc.name}` }, () =>
      deps.mongo.db
        .collection(cc.name)
        .estimatedDocumentCount({ maxTimeMS: ctx.config.mongo.maxTimeMs })
    )
  );

  if (estimated <= smallCollectionDocs) return true;

  ctx.emit({
    type: 'warn',
    command: ctx.command,
    message:
      `${cc.name}: rest chunk skipped (rest: auto, about ${formatCount(estimated)} ` +
      'documents); set rest: export or pass --include-rest',
  });

  return false;
}

/**
 * The cutoff of a new batch: `now - safetyLagMinutes` floored to the hour, or `--cutoff`. One in
 * the future is refused: its windows would run now, documents written into them later would be in
 * no chunk, and the next `--since last` would start after them. One inside the safety lag only
 * warns.
 */
function resolveCutoff(ctx: RunContext, now: Date, cutoff: string | undefined): Date {
  const lagMs = ctx.config.export.safetyLagMinutes * 60_000;

  if (cutoff === undefined) return floorTo(new Date(now.getTime() - lagMs), durations.hourMs);

  const at = parseInstant(cutoff, '--cutoff');

  if (at.getTime() > now.getTime())
    throw config(
      `--cutoff ${cutoff} is in the future; the next --since last would skip what ` +
        'is written until then'
    );

  if (at.getTime() > now.getTime() - lagMs)
    ctx.emit({
      type: 'warn',
      command: ctx.command,
      message:
        `--cutoff ${cutoff} is inside the ${ctx.config.export.safetyLagMinutes} ` +
        'minute safety lag; documents still being written may be missed',
    });

  return at;
}

/**
 * Decides which batch this invocation works on: an existing batch resumes its frozen plan (so a
 * fixed `--batch-id` in a unit file starts once and resumes forever), a new one gets its kind,
 * cutoff and per-collection plan from the options and the config.
 */
export default async function resolveBatch(
  ctx: RunContext,
  deps: ExportSources,
  options: ExportOptions
): Promise<BatchPlan> {
  if (options.batchId !== undefined) {
    if (!batchIdPattern.test(options.batchId))
      throw config(
        `--batch-id ${options.batchId}: letters, digits, dot, underscore, hyphen; max 121`
      );

    const key = deps.layout.batchManifest(options.batchId);
    const record = await readRecord(deps.store, key, recordSchemas.batchManifest);

    if (record !== null)
      return fromFrozenPlan(ctx, key, record.value, { ...options, batchId: options.batchId });
  }

  const now = ctx.now();
  const kind: 'full' | 'delta' = options.since === undefined ? 'full' : 'delta';

  const windowedNames = options.collections
    .filter(cc => cc.strategy !== undefined && cc.strategy !== 'full-collection')
    .map(cc => cc.name);

  const last = options.since === 'last' ? await sinceLast(ctx, deps, windowedNames) : null;

  const explicitSince =
    options.since === undefined || options.since === 'last'
      ? null
      : parseInstant(options.since, '--since');

  const sinceFor = (name: string): Date | null =>
    last === null ? explicitSince : (last.perCollection.get(name) ?? last.newest);

  const cutoff = resolveCutoff(ctx, now, options.cutoff);

  const batchId =
    options.batchId ?? `${ctx.config.export.batchPrefix}-${kind}-${formatUtc(now, 'compact')}`;

  const includeRest = options.includeRest ?? false;

  const collections: PlannedCollection[] = [];
  const sinces: Date[] = [];

  for (const cc of options.collections) {
    if (cc.strategy === undefined)
      throw config(
        `collection ${cc.name} has no strategy; run inventory --write-config or set one`
      );

    if (cc.strategy === 'full-collection') {
      collections.push({
        collection: cc.name,
        mode: cc.strategy,
        field: null,
        window: null,
        start_utc: null,
        rest: false,
      });

      continue;
    }

    const since = sinceFor(cc.name);

    if (since !== null) {
      if (since.getTime() >= cutoff.getTime())
        throw config(
          `${cc.name}: --since ${formatUtc(since, 'z')} is not before the cutoff ` +
            `${formatUtc(cutoff, 'z')}`
        );

      sinces.push(since);
    }

    const configured = cc.start === undefined ? null : parseInstant(cc.start, `${cc.name}.start`);

    const start =
      since === null
        ? configured
        : new Date(Math.max(since.getTime(), configured?.getTime() ?? -Infinity));

    collections.push({
      collection: cc.name,
      mode: cc.strategy,
      field: cc.strategy === 'timestamp-window' ? (cc.field ?? null) : null,
      window: cc.window,
      start_utc: start === null ? null : formatUtc(start, 'z'),
      rest: await wantsRest(ctx, deps, cc, kind, includeRest),
    });
  }

  // The batch-level `since` (requested_start_utc) is the earliest per-collection start; a delta of
  // only full-collection collections keeps the newest complete batch's as its record.
  const since =
    kind === 'full'
      ? null
      : sinces.length > 0
        ? new Date(Math.min(...sinces.map(d => d.getTime())))
        : (explicitSince ?? last?.newest ?? null);

  if (since !== null && since.getTime() >= cutoff.getTime())
    throw config(
      `--since ${formatUtc(since, 'z')} is not before the cutoff ${formatUtc(cutoff, 'z')}`
    );

  return {
    batchId,
    kind,
    cutoff,
    since,
    startedAt: now,
    collections,
    includeRest,
    resumed: false,
    outOfRange: Object.create(null) as BatchPlan['outOfRange'],
  };
}
