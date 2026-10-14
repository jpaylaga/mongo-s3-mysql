import type { Pool } from 'mysql2/promise';
import exitCodes from '../cli/exitCodes.js';
import bareCollection from '../config/bareCollection.js';
import createLayout from '../layout/createLayout.js';
import discoverCollections from '../layout/discoverCollections.js';
import listBatchManifests from '../layout/listBatchManifests.js';
import readRecord from '../layout/readRecord.js';
import recordSchemas from '../layout/recordSchemas.js';
import loadMapping from '../mapping/loadMapping.js';
import resolveMappingPath from '../mapping/resolveMappingPath.js';
import valueColumns from '../mapping/valueColumns.js';
import acquireTableLock from '../mysql/acquireTableLock.js';
import checkTableShape from '../mysql/checkTableShape.js';
import markChunkReplayPending from '../mysql/markChunkReplayPending.js';
import missingLedgerDdl from '../mysql/missingLedgerDdl.js';
import readTableInfo from '../mysql/readTableInfo.js';
import abortExitCode from '../runtime/abortExitCode.js';
import acquireLock from '../runtime/acquireLock.js';
import checkFreeSpace from '../runtime/checkFreeSpace.js';
import formatCount from '../runtime/formatCount.js';
import formatUtc from '../runtime/formatUtc.js';
import mapLimit from '../runtime/mapLimit.js';
import msmError from '../runtime/msmError.js';
import prepareTempDir from '../runtime/prepareTempDir.js';
import withRetry from '../runtime/withRetry.js';
import type {
  ChunkOutcome, CollectionConfig, ExitCode, Layout, LedgerRow, LoadBatchRef, LoadCandidate, LoadOptions, LoadResult, LoadRun, LoadSelection, LoadTarget,
  Mapping, MysqlHandle, ObjectStore, RunContext, ShapeOptions, SkippedChunk, TableInfo, TableLock,
} from '../types.js';
import createPlanner from './createPlanner.js';
import dryRunResult from './dryRunResult.js';
import readLedgers from './readLedgers.js';
import runChunks from './runChunks.js';
import summarizePerTable from './summarizePerTable.js';

/** The ledger column is `VARCHAR(64) CHARACTER SET ascii`; the run id also lands in every `runIdColumn`. */
const loadRunIdPattern = /^[\x21-\x7e]{1,64}$/;

/** What the shape check needs from the run: the key ledger switch, the run id every row gets, the concurrency and the session zone. */
const shapeOptions = (ctx: RunContext, loadRunId: string): ShapeOptions => ({
  keyLedger: ctx.config.load.keyLedger, loadRunId, concurrency: ctx.config.load.concurrency, sessionTimeZone: ctx.config.mysql?.sessionTimeZone, now: ctx.now(),
});

async function readTables(pool: Pool, database: string, mapping: Mapping): Promise<Map<string, TableInfo | null>> {
  const tables = new Map<string, TableInfo | null>();
  for (const name of [mapping.table, ...mapping.children.map((c) => c.table)]) tables.set(name, await readTableInfo(pool, database, name));
  return tables;
}

/**
 * One collection's mapping and live tables. Shape problems are fatal, except missing tables when
 * `--create-tables` is set: their DDL is queued and the check runs again after it. A collection without a
 * mapping file is skipped; one whose configured `mapping` path is missing is a config error.
 */
async function resolveTarget(ctx: RunContext, mysql: MysqlHandle, cc: CollectionConfig, createTables: boolean, loadRunId: string): Promise<{ target: LoadTarget; ddl: string[]; created: string[] } | null> {
  const { config } = ctx;
  const path = await resolveMappingPath(ctx, cc);
  if (path === null) return null;
  const loaded = await loadMapping(path);
  const { mapping } = loaded;
  const database = (config.mysql as NonNullable<typeof config.mysql>).database;
  const tables = await readTables(mysql.pool, database, mapping);
  const report = checkTableShape(mapping, tables, shapeOptions(ctx, loadRunId));
  const problems = createTables ? report.problems.filter((p) => !p.startsWith('missing table ')) : report.problems;
  if (problems.length > 0) throw msmError('config', `${cc.name}: table shape problems:\n${problems.join('\n')}`, { fatal: true });
  for (const warning of report.warnings) ctx.emit({ type: 'warn', command: ctx.command, message: `${cc.name}: ${warning}` });
  const children = new Map<string, TableInfo>();
  for (const child of mapping.children) {
    const info = tables.get(child.table);
    if (info) children.set(child.table, info);
  }
  // A missing parent table is filled in after its CREATE TABLE ran (see `recheckTargets`).
  const table = tables.get(mapping.table) ?? { name: mapping.table, columns: new Map(), uniqueKeys: [], primaryKey: [], primaryKeyPrefix: false, indexedColumns: [] };
  return { target: { loaded, table, children, columns: valueColumns(mapping) }, ddl: createTables ? report.ddl : [], created: createTables ? report.created : [] };
}

/** After `--create-tables` ran its DDL, the created tables are read back and checked like any other. */
async function recheckTargets(ctx: RunContext, mysql: MysqlHandle, targets: Map<string, LoadTarget>, created: Set<string>, loadRunId: string): Promise<void> {
  const database = (ctx.config.mysql as NonNullable<typeof ctx.config.mysql>).database;
  for (const [collection, target] of targets) {
    const { mapping } = target.loaded;
    if (![mapping.table, ...mapping.children.map((c) => c.table)].some((t) => created.has(t))) continue;
    const tables = await readTables(mysql.pool, database, mapping);
    const report = checkTableShape(mapping, tables, shapeOptions(ctx, loadRunId));
    if (report.problems.length > 0) throw msmError('config', `${collection}: table shape problems after CREATE TABLE:\n${report.problems.join('\n')}`, { fatal: true });
    const table = tables.get(mapping.table);
    if (table) target.table = table;
    for (const child of mapping.children) {
      const info = tables.get(child.table);
      if (info) target.children.set(child.table, info);
    }
  }
}

/** Every selected collection's target, plus the `--create-tables` DDL and the names of the tables it creates. */
async function resolveTargets(ctx: RunContext, mysql: MysqlHandle, collections: CollectionConfig[], createTables: boolean, loadRunId: string): Promise<{ targets: Map<string, LoadTarget>; ddl: string[]; created: string[] }> {
  const targets = new Map<string, LoadTarget>();
  const ddl: string[] = [];
  const created: string[] = [];
  for (const cc of collections) {
    const resolved = await resolveTarget(ctx, mysql, cc, createTables, loadRunId);
    if (resolved === null) continue;
    targets.set(cc.name, resolved.target);
    ddl.push(...resolved.ddl);
    created.push(...resolved.created);
  }
  return { targets, ddl, created };
}

const byCutoff = (a: LoadBatchRef, b: LoadBatchRef): number => {
  if (a.cutoff === null || b.cutoff === null) return a.cutoff === b.cutoff ? a.id.localeCompare(b.id) : a.cutoff === null ? 1 : -1;
  return a.cutoff.localeCompare(b.cutoff) || a.id.localeCompare(b.id);
};

async function resolveBatches(ctx: RunContext, store: ObjectStore, layout: Layout, ids: string[] | undefined): Promise<LoadBatchRef[]> {
  if (ids !== undefined && ids.length > 0) {
    const batches = await mapLimit(ids, 4, async (id): Promise<LoadBatchRef> => {
      const record = await readRecord(store, layout.batchManifest(id), recordSchemas.batchManifest);
      if (record === null) ctx.emit({ type: 'warn', command: ctx.command, message: `batch ${id} has no batch manifest; its cutoff is unknown` });
      return { id, cutoff: record?.value.cutoff_utc ?? null };
    });
    return batches.sort(byCutoff);
  }
  return (await listBatchManifests(store, layout)).map(({ batch }) => ({ id: batch.run_id, cutoff: batch.cutoff_utc }));
}

/** The run ids each target table gets, in `tables` order, for the per-table summary. */
function chunksByTable(tables: string[], candidates: LoadCandidate[], tableFor: (collection: string) => string): Map<string, Set<string>> {
  return new Map(tables.map((table) => [table, new Set(candidates.filter((c) => tableFor(c.resolved.collection) === table).map((c) => c.resolved.runId))]));
}

/**
 * Batches load oldest cutoff first so the last writer holds the newest data. An older batch may only write a
 * table when every chunk of a newer batch that already wrote rows to that table (loaded, or partly loaded
 * and interrupted) replays after it from line 0 in this run; such candidates are forced to `reload` and
 * returned, so the obligation can be persisted before the older batch writes. Any other newer chunk is a
 * refusal, or a warning under `--allow-older`.
 */
function orderGuard(
  ctx: RunContext, selections: LoadSelection[], ledgers: Map<string, LedgerRow[]>, tableFor: (collection: string) => string, allowOlder: boolean,
): LoadCandidate[] {
  const candidates = new Map<string, LoadCandidate>();
  for (const s of selections) for (const c of s.candidates) candidates.set(`${tableFor(c.resolved.collection)}\0${c.resolved.runId}`, c);
  const forced = new Set<LoadCandidate>();
  for (const { batch, candidates: mine } of selections) {
    if (mine.length === 0 || batch.cutoff === null) continue;
    const cutoff = Date.parse(batch.cutoff);
    for (const table of new Set(mine.map((c) => tableFor(c.resolved.collection)))) {
      const blocking = new Map<string, string[]>();
      for (const r of ledgers.get(table) ?? []) {
        if (r.batch_cutoff_utc === null || r.batch_id === batch.id || r.lines_done === 0 || Date.parse(r.batch_cutoff_utc) <= cutoff) continue;
        const replay = candidates.get(`${table}\0${r.chunk_run_id}`);
        if (replay !== undefined) { replay.reload = true; forced.add(replay); continue; }
        blocking.set(r.batch_id, [...(blocking.get(r.batch_id) ?? []), r.chunk_run_id]);
      }
      for (const [id, chunks] of blocking) {
        const message = `batch ${batch.id} is older than loaded ${id} (${table}: ${chunks.join(', ')}); include ${id} with --reload or pass --allow-older`;
        if (!allowOlder) throw msmError('config', message, { fatal: true });
        ctx.emit({ type: 'warn', command: ctx.command, message: `batch ${batch.id} is older than loaded ${id}; loading it anyway (--allow-older)` });
      }
    }
  }
  return [...forced];
}

/** What the plan decided per chunk, so the plan taken before the prompt can be compared with one taken under the locks. */
const planSignature = (selections: LoadSelection[]): string => JSON.stringify(selections.map((s) => [
  s.batch.id, s.candidates.map((c) => [c.resolved.runId, c.reload]), s.skipped.map((k) => [k.resolved.runId, k.severity]),
]));

const exitFor = (signal: AbortSignal, outcomes: ChunkOutcome[], skipped: SkippedChunk[]): ExitCode => {
  if (outcomes.some((o) => o.status === 'interrupted')) return abortExitCode(signal);
  if (outcomes.some((o) => o.status === 'failed') || skipped.some((s) => s.severity === 'incomplete')) return exitCodes.incomplete;
  return exitCodes.ok;
};

/**
 * The load orchestration: lock, resolve mappings against the live tables, discover and select chunks per
 * batch, guard the batch order, confirm, create the ledger (and tables with `--create-tables`), take one
 * GET_LOCK per table, select and guard again on the ledger as it is under the locks, persist every forced
 * replay, then load batch after batch with concurrent chunks. Every chunk's progress lives in
 * `_msm_load_chunks`, so an interrupted run resumes where it committed. Every phase before the chunks runs
 * under the run signal, so a signal anywhere in it is a 130/143 result, never a rejection.
 */
export default async function load(options: LoadOptions): Promise<LoadResult> {
  const { ctx, store, mysql } = options;
  const { config } = ctx;
  if (config.mysql === undefined) throw msmError('config', 'config: the "mysql" section is required', { fatal: true });
  const mysqlConfig = config.mysql;
  const loadRunId = options.loadRunId ?? `load-${formatUtc(ctx.now(), 'compact')}`;
  if (!loadRunIdPattern.test(loadRunId)) throw msmError('config', `--load-run-id ${JSON.stringify(loadRunId)}: 1 to 64 printable ASCII characters without spaces`, { fatal: true });
  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const info = (message: string) => ctx.emit({ type: 'info', command: ctx.command, message });
  // The ledger (and `--create-tables` DDL) may already have run by then, so the message does not promise an untouched database.
  const interrupted = (): LoadResult => {
    warn(`load ${loadRunId} interrupted before any chunk ran; no rows were loaded`);
    return { loadRunId, outcomes: [], perTable: [], exitCode: abortExitCode(ctx.signal) };
  };
  const releaseLock = await acquireLock(config.stateDir, 'load', options.forceUnlock ?? false, warn);
  const locks = new Map<string, TableLock>();
  const local = new AbortController();
  try {
    // Downloaded parts hold the documents; a shared tempDir volume must neither expose them nor let another user plant paths.
    const tempDir = await prepareTempDir(config, 'load');
    (await checkFreeSpace(tempDir, config.minFreeDiskMb))();
    const layout = createLayout(config.s3);
    const maxRowBytes = Math.floor(0.9 * mysql.maxAllowedPacket);
    const maxBatchBytes = Math.min(config.load.batchMaxBytesMb * 1024 * 1024, maxRowBytes);

    // Planning: a signal here (every S3 and MySQL read runs under it) is a result, not a failure.
    let targets: Map<string, LoadTarget>;
    let ddl: string[];
    let created: string[];
    let batches: LoadBatchRef[];
    let plan: (ledgers: Map<string, LedgerRow[]>) => Promise<LoadSelection[]>;
    let ledgers: Map<string, LedgerRow[]>;
    let selections: LoadSelection[];
    try {
      // Like verify and reconcile, an empty collection list means every collection the archive holds.
      const collections = options.collections.length > 0 ? options.collections : (await discoverCollections(store, layout)).map((name) => bareCollection(name));
      ({ targets, ddl, created } = await resolveTargets(ctx, mysql, collections, options.createTables ?? false, loadRunId));
      batches = await resolveBatches(ctx, store, layout, options.batchIds);
      plan = createPlanner(store, layout, targets, batches, { allowMismatch: options.allowMismatch ?? false, allowUnverified: options.allowUnverified ?? false, reload: options.reload ?? false });
      ledgers = await readLedgers(ctx, mysql.pool, targets);
      selections = await plan(ledgers);
    } catch (err) {
      if (ctx.signal.aborted) return interrupted();
      throw err;
    }
    const tables = [...new Set([...targets.values()].map((t) => t.table.name))];
    const tableFor = (collection: string): string => targets.get(collection)?.table.name ?? collection;
    orderGuard(ctx, selections, ledgers, tableFor, options.allowOlder ?? false);

    const candidates = selections.flatMap((s) => s.candidates);
    const skipped = selections.flatMap((s) => s.skipped);
    for (const s of skipped) if (s.severity !== 'info') ctx.emit({ type: 'chunk', command: ctx.command, chunk: s.resolved.runId, status: 'skipped', detail: s.reason });
    const skippedOutcomes: ChunkOutcome[] = skipped.map((s) => ({ chunk: s.resolved.runId, collection: s.resolved.collection, status: 'skipped', note: s.reason }));
    const byTable = chunksByTable(tables, candidates, tableFor);
    if (options.dryRun) return dryRunResult(info, loadRunId, selections, ddl, byTable, skippedOutcomes);
    if (candidates.length === 0) {
      info(`nothing to load: ${formatCount(skipped.length)} chunks skipped`);
      return { loadRunId, outcomes: skippedOutcomes, perTable: await summarizePerTable(mysql.pool, byTable), exitCode: exitFor(ctx.signal, [], skipped) };
    }

    if (ctx.signal.aborted) return interrupted();
    const docs = candidates.reduce((sum, c) => sum + c.resolved.manifest.exported_count, 0);
    await options.confirm?.(`Upsert ~${formatCount(docs)} documents from ${formatCount(candidates.length)} chunks into ${mysqlConfig.database}.${tables.join(', ')} on ${mysqlConfig.host}?${ddl.length > 0 ? ` ${formatCount(ddl.length)} CREATE TABLE runs first.` : ''}`);
    if (ctx.signal.aborted) return interrupted();

    // Every statement here runs under the run signal through withRetry, so a signal during the DDL (or a
    // backoff after a transient DDL error) must come out as 130/143 like one during planning, not as a rejection.
    try {
      const statements = [...await missingLedgerDdl(mysql.pool, mysqlConfig.database, config.load.keyLedger), ...ddl];
      for (const statement of statements) await withRetry(ctx, { source: 'mysql', name: 'CREATE TABLE' }, () => mysql.pool.query(statement));
      if (ddl.length > 0) await recheckTargets(ctx, mysql, targets, new Set(created), loadRunId);
    } catch (err) {
      if (ctx.signal.aborted) return interrupted();
      throw err;
    }
    if (ctx.signal.aborted) return interrupted();

    // The lock phase runs under the signal like planning and the DDL: a signal while connecting for a GET_LOCK, re-reading
    // the ledgers or marking replays is a 130/143 result, not a `readLedger: interrupted` rejection.
    try {
      for (const table of tables) locks.set(table, await acquireTableLock(mysql, mysqlConfig.database, table, (err) => local.abort(err)));
      if (ctx.signal.aborted) return interrupted();

      // Another loader may have finished a batch while this run sat at the prompt: the plan is taken again on the
      // ledger as it is now, under the locks, and a different outcome stops the run instead of loading over it.
      const confirmed = planSignature(selections);
      ledgers = await readLedgers(ctx, mysql.pool, targets);
      selections = await plan(ledgers);
      const forced = orderGuard(ctx, selections, ledgers, tableFor, options.allowOlder ?? false);
      if (planSignature(selections) !== confirmed) throw msmError('config', 'the load ledger changed while waiting for the prompt or the locks; rerun load', { fatal: true });
      // A newer chunk forced to replay after an older batch is marked in the ledger first: an interrupt between
      // the two batches must not leave the table holding the older batch's rows under a `loaded` newer chunk.
      for (const cand of forced) {
        await withRetry(ctx, { source: 'mysql', name: `replay pending ${cand.resolved.runId}` }, () => markChunkReplayPending(mysql.pool, tableFor(cand.resolved.collection), cand.resolved.runId));
      }
    } catch (err) {
      if (ctx.signal.aborted) return interrupted();
      throw err;
    }
    if (ctx.signal.aborted) return interrupted();

    const chunkCtx: RunContext = { ...ctx, signal: AbortSignal.any([ctx.signal, local.signal]) };
    const run: LoadRun = { ctx: chunkCtx, store, mysql, loadRunId, maxBatchBytes, maxRowBytes, targets, locks, batchCutoffs: new Map(batches.map((b) => [b.id, b.cutoff])) };
    const { outcomes, fatal, docs: loadedDocs } = await runChunks(run, selections, local, tableFor);
    // A lost lock pulls the local signal with its own fatal error, which outranks the interrupted outcomes it caused.
    const failure = fatal ?? (local.signal.aborted && !ctx.signal.aborted ? local.signal.reason : null);
    if (failure !== null) throw failure;

    const exitCode = exitFor(ctx.signal, outcomes, skipped);
    info(`load ${loadRunId}: ${formatCount(outcomes.filter((o) => o.status === 'done').length)} of ${formatCount(candidates.length)} chunks loaded, ${formatCount(loadedDocs)} documents this run, ${formatCount(skipped.length)} skipped`);
    return { loadRunId, outcomes: [...outcomes, ...skippedOutcomes], perTable: await summarizePerTable(mysql.pool, byTable), exitCode };
  } finally {
    for (const lock of locks.values()) await lock.release();
    await releaseLock();
  }
}
