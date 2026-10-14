import exitCodes from '../cli/exitCodes.js';
import bareCollection from '../config/bareCollection.js';
import createLayout from '../layout/createLayout.js';
import discoverCollections from '../layout/discoverCollections.js';
import listBatchManifests from '../layout/listBatchManifests.js';
import listChunkManifests from '../layout/listChunkManifests.js';
import readRecord from '../layout/readRecord.js';
import recordSchemas from '../layout/recordSchemas.js';
import loadMapping from '../mapping/loadMapping.js';
import resolveMappingPath from '../mapping/resolveMappingPath.js';
import readLedger from '../mysql/readLedger.js';
import readTableInfo from '../mysql/readTableInfo.js';
import abortExitCode from '../runtime/abortExitCode.js';
import acquireLock from '../runtime/acquireLock.js';
import formatBytes from '../runtime/formatBytes.js';
import formatCount from '../runtime/formatCount.js';
import isMsmError from '../runtime/isMsmError.js';
import msmError from '../runtime/msmError.js';
import prepareTempDir from '../runtime/prepareTempDir.js';
import withRetry from '../runtime/withRetry.js';
import type {
  BatchManifest, CollectionConfig, Drift, DriftKind, ExitCode, LedgerRow, LoadedMapping, ReconcileOptions, ReconcileResult, ReconcileRun,
  ResolvedManifest, RunContext, TableInfo,
} from '../types.js';
import chunkDrift from './chunkDrift.js';
import deepCheck from './deepCheck.js';
import tableCheck from './tableCheck.js';

/**
 * Everything one collection's record checks need: its own ledger rows (never another collection's that shares
 * the table). `sharedWith` names the other collections the table's ledger knows, so a whole-table proof can
 * tell when some of them are not in this run.
 */
interface Target {
  name: string; loaded: LoadedMapping; table: TableInfo; ledger: LedgerRow[]; selected: LedgerRow[];
  batches: BatchManifest[]; noManifest: string[]; manifests: ResolvedManifest[]; whole: boolean; sharedWith: string[];
}

/** The table-side proofs run once per target table, over every collection that maps to it. */
interface TableGroup { table: TableInfo; loaded: LoadedMapping; targets: Target[]; selected: LedgerRow[]; manifests: ResolvedManifest[]; whole: boolean }

/** Everything one collection contributes, or null when it has no mapping file and was not named with `-C`. */
async function gather(run: ReconcileRun, cc: CollectionConfig, batchIds: string[] | undefined, narrowed: boolean): Promise<Target | null> {
  const { ctx, store, layout, mysql } = run;
  const database = ctx.config.mysql?.database;
  if (database === undefined) throw msmError('config', 'config: the "mysql" section is required', { fatal: true });
  const path = await resolveMappingPath(ctx, cc, narrowed);
  if (path === null) return null;
  const loaded = await loadMapping(path);
  const table = await withRetry(ctx, { source: 'mysql', name: `readTableInfo ${loaded.mapping.table}` }, () => readTableInfo(mysql.pool, database, loaded.mapping.table));
  if (table === null) throw msmError('config', `${cc.name}: table ${database}.${loaded.mapping.table} does not exist`, { fatal: true });
  // The table's ledger holds every collection that maps to it; only this collection's rows are matched to its manifests.
  const tableLedger = await withRetry(ctx, { source: 'mysql', name: `readLedger ${table.name}` }, () => readLedger(mysql.pool, table.name));
  const ledger = tableLedger.filter((r) => r.collection === cc.name);
  const sharedWith = [...new Set(tableLedger.map((r) => r.collection).filter((c) => c !== cc.name))].sort();

  // --batch-id narrows the proof; otherwise every batch the ledger knows, or (nothing loaded) every batch archived.
  let ids: string[];
  let whole = false;
  if (batchIds !== undefined && batchIds.length > 0) ids = batchIds;
  else if (ledger.length > 0) { ids = [...new Set(ledger.map((r) => r.batch_id))]; whole = true; }
  else { ids = (await listBatchManifests(store, layout)).map(({ batch }) => batch.run_id); whole = true; }

  const batches: BatchManifest[] = [];
  const noManifest: string[] = [];
  const manifests: ResolvedManifest[] = [];
  for (const id of ids) {
    const record = await readRecord(store, layout.batchManifest(id), recordSchemas.batchManifest);
    if (record === null) noManifest.push(id);
    else batches.push(record.value);
    manifests.push(...await listChunkManifests(store, layout, cc.name, id));
  }
  // A name given with -C that nothing archived or loaded is a typo or another prefix, not a clean result.
  if (narrowed && manifests.length === 0 && ledger.length === 0) {
    throw msmError('config', `-C ${cc.name}: no chunk manifest under s3://${layout.bucket}/${ctx.config.s3.prefix} and no ledger row in ${table.name}; check the name`, { fatal: true });
  }
  const selected = ledger.filter((r) => ids.includes(r.batch_id));
  return { name: cc.name, loaded, table, ledger, selected, batches, noManifest, manifests, whole, sharedWith };
}

/** The most frequent reject reasons of the selected chunks, for the informational line. */
async function rejectReasons(run: ReconcileRun, selected: LedgerRow[]): Promise<string[]> {
  const ids = selected.filter((r) => r.rows_rejected > 0).map((r) => r.id);
  if (ids.length === 0) return [];
  try {
    const [rows] = await run.mysql.pool.query(
      'SELECT `reason`, COUNT(*) AS c FROM `_msm_load_rejects` WHERE `chunk_id` IN (?) GROUP BY `reason` ORDER BY c DESC, `reason` LIMIT 5', [ids]);
    return (rows as { reason: unknown; c: unknown }[]).map((r) => `${String(r.reason)} (${formatCount(Number(r.c))})`);
  } catch {
    return []; // informational only: a missing rejects table changes nothing
  }
}

/**
 * Targets that share a table are proven together; the first one's mapping gives the key column, which they must
 * share. A table is only proven whole when every collection its ledger knows is in the run: with `-C` naming
 * some of them, the others' rows would otherwise be reported as unknown.
 */
function groupByTable(targets: Target[], warn: (message: string) => void): TableGroup[] {
  const groups = new Map<string, TableGroup>();
  for (const t of targets) {
    const group = groups.get(t.table.name);
    if (group === undefined) {
      groups.set(t.table.name, { table: t.table, loaded: t.loaded, targets: [t], selected: [...t.selected], manifests: [...t.manifests], whole: t.whole });
      continue;
    }
    if (group.loaded.mapping.key.column !== t.loaded.mapping.key.column) {
      throw msmError('config', `${t.name} and ${group.targets[0]?.name} both load ${t.table.name} but with different key columns (${t.loaded.mapping.key.column}, ${group.loaded.mapping.key.column})`, { fatal: true });
    }
    group.targets.push(t);
    group.selected.push(...t.selected);
    group.manifests.push(...t.manifests);
    group.whole = group.whole && t.whole;
  }
  for (const group of groups.values()) {
    const names = new Set(group.targets.map((t) => t.name));
    const outside = [...new Set(group.targets.flatMap((t) => t.sharedWith))].filter((c) => !names.has(c)).sort();
    if (outside.length === 0 || !group.whole) continue;
    group.whole = false;
    warn(`${group.table.name}: also loaded from ${outside.join(', ')}, not selected in this run; their rows count as foreign and the whole-table deep check is skipped`);
  }
  return [...groups.values()];
}

const exitFor = (signal: AbortSignal, drifts: Drift[], ignore: Set<DriftKind>): ExitCode => {
  if (signal.aborted) return abortExitCode(signal);
  return drifts.some((d) => !ignore.has(d.kind)) ? exitCodes.drift : exitCodes.ok;
};

/**
 * Read-only comparison of the archive's records, the load ledger and the target tables. Every drift is
 * reported through `ctx.emit` and returned; the exit code is 4 unless every drift's kind is in `ignore`.
 * `--deep` reads the selected chunks' parts once, after asking, under the `reconcile` lock (two deep runs
 * from one state directory would share the download directory, which is wiped at the start like load's). A
 * run that checked no table at all is a config error, not "no drift": this is the gate before the source is
 * retired, and a typo in `-C` or an empty mappings directory must not pass it. An interrupt returns what was
 * found so far with the signal's exit code.
 */
export default async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const { ctx, store, mysql } = options;
  const { config } = ctx;
  const layout = createLayout(config.s3);
  const run: ReconcileRun = { ctx, store, layout, mysql };
  const warn = (message: string) => ctx.emit({ type: 'warn', command: ctx.command, message });
  const info = (message: string) => ctx.emit({ type: 'info', command: ctx.command, message });
  const ignore = new Set<DriftKind>(options.ignore ?? []);
  const keyLedger = config.load.keyLedger;
  const releaseLock = options.deep ? await acquireLock(config.stateDir, 'reconcile', options.forceUnlock ?? false, warn) : async () => undefined;

  const drifts: Drift[] = [];
  const perTable: ReconcileResult['perTable'] = [];
  const report = (list: Drift[]) => {
    for (const d of list) {
      drifts.push(d);
      warn(`${d.table}: ${d.kind}${d.chunk ? ` [${d.chunk}]` : ''}: ${d.detail}${ignore.has(d.kind) ? ' (ignored)' : ''}`);
    }
  };
  const interrupted = (): ReconcileResult => {
    warn('reconcile interrupted; the comparison so far is reported');
    return { drifts, perTable, exitCode: abortExitCode(ctx.signal) };
  };

  try {
    // The downloads of a crashed deep run would otherwise stay under tempDir for good: no later run visits that chunk
    // directory. Inside the try, as in load and export: a refused scratch area (a planted or open owner directory) must release the lock.
    if (options.deep) await prepareTempDir(config, 'reconcile');
    const collections = options.collections.length > 0 ? options.collections : (await discoverCollections(store, layout)).map((name) => bareCollection(name));
    const targets: Target[] = [];
    for (const cc of collections) {
      if (ctx.signal.aborted) return interrupted();
      const target = await gather(run, cc, options.batchIds, options.narrowed ?? false);
      if (target !== null) targets.push(target);
    }
    if (targets.length === 0) throw msmError('config', `nothing reconciled: no selected collection has a mapping under ${config.mappingsDir}; run infer first, or check -C and mappingsDir`, { fatal: true });
    // A requested batch that no manifest and no ledger row knows is a typo or another prefix, not a clean result.
    for (const id of options.batchIds ?? []) {
      const known = targets.some((t) => t.batches.some((b) => b.run_id === id) || t.manifests.some((m) => m.batchId === id) || t.ledger.some((r) => r.batch_id === id));
      if (!known) throw msmError('config', `batch ${id} not found under s3://${layout.bucket}/${config.s3.prefix}: no batch manifest, no chunk manifest and no ledger row`, { fatal: true });
    }
    for (const id of new Set(targets.flatMap((t) => t.noManifest))) warn(`batch ${id} has no batch manifest; its completeness cannot be checked`);

    for (const target of targets) {
      const { table, selected, batches, manifests } = target;
      const chunkDrifts = chunkDrift(table.name, batches, manifests, selected);
      report(chunkDrifts);
      if (options.showOk) {
        const drifted = new Set(chunkDrifts.map((d) => d.chunk));
        for (const m of manifests) if (!drifted.has(m.runId)) ctx.emit({ type: 'chunk', command: ctx.command, chunk: m.runId, status: 'done', detail: `${formatCount(m.manifest.exported_count)} docs, ledger agrees` });
      }
    }

    // `expected` per table is the key ledger's count, or null when it cannot stand in for the parts (ledger off, or chunks loaded without it).
    const groups = groupByTable(targets, warn);
    const expectedByTable = new Map<string, number | null>();
    for (const group of groups) {
      if (ctx.signal.aborted) return interrupted();
      const { table, loaded, selected, manifests } = group;
      const check = await withRetry(ctx, { source: 'mysql', name: `tableCheck ${table.name}` }, () => tableCheck(mysql.pool, loaded.mapping, table, selected, keyLedger));
      report(check.drifts);
      expectedByTable.set(table.name, check.unproven.length > 0 ? null : check.expected);
      if (!keyLedger) warn(`${table.name}: table coverage unproven without the key ledger (load.keyLedger is false); run --deep`);
      else if (check.unproven.length > 0) warn(`${table.name}: coverage unproven for ${formatCount(check.unproven.length)} chunks loaded wholly or partly without the key ledger (${check.unproven.slice(0, 3).join(', ')}${check.unproven.length > 3 ? ', ...' : ''}); run --deep`);

      const rejected = selected.reduce((sum, r) => sum + r.rows_rejected, 0);
      const castErrors = selected.reduce((sum, r) => sum + r.cast_errors, 0);
      if (rejected > 0) info(`${table.name}: ${formatCount(rejected)} lines rejected at load; reasons: ${(await rejectReasons(run, selected)).join('; ')}`);
      if (castErrors > 0) info(`${table.name}: ${formatCount(castErrors)} columns nulled by cast errors (onCastError: null)`);
      const mismatch = selected.filter((r) => manifests.some((m) => m.runId === r.chunk_run_id && !m.manifest.counts_match)).length;
      if (mismatch > 0) info(`${table.name}: ${formatCount(mismatch)} chunks were loaded with --allow-mismatch`);
      if (check.untracked > 0) info(`${table.name}: ${formatCount(check.untracked)} rows have no key (the application's own)`);
      if (check.foreign > 0) info(`${table.name}: ${formatCount(check.foreign)} keyed rows are outside the selected batches (other batches or an earlier importer)`);
      perTable.push({ table: table.name, chunks: selected.length, keyed: check.keyed, untracked: check.untracked, foreign: check.foreign, rejected, castErrors, deep: false });
    }

    if (options.deep && !ctx.signal.aborted) {
      const toRead = groups.map((group) => {
        const loadedIds = new Set(group.selected.map((r) => r.chunk_run_id));
        const chunks = group.manifests.filter((m) => loadedIds.has(m.runId));
        const parts = chunks.flatMap((m) => m.parts);
        return { group, parts: parts.length, bytes: parts.reduce((s, p) => s + p.bytes, 0), chunks: chunks.length };
      });
      const bytes = toRead.reduce((s, r) => s + r.bytes, 0);
      const parts = toRead.reduce((s, r) => s + r.parts, 0);
      const chunks = toRead.reduce((s, r) => s + r.chunks, 0);
      if (options.confirm) await options.confirm(`Read ${formatBytes(bytes)} in ${formatCount(parts)} parts of ${formatCount(chunks)} chunks to prove ${formatCount(groups.length)} tables row by row?`);
      for (const { group } of toRead) {
        if (ctx.signal.aborted) return interrupted();
        const { table, loaded, selected, manifests, whole } = group;
        const deep = await deepCheck(run, loaded.mapping, table, selected, manifests, whole);
        report(deep.drifts);
        const expected = expectedByTable.get(table.name) ?? null;
        if (expected !== null && deep.distinct !== expected) {
          report([{ table: table.name, kind: 'deep_distinct', chunk: null, expected, actual: deep.distinct,
            detail: `${formatCount(deep.distinct)} distinct ids read from the parts, the key ledger holds ${formatCount(expected)}` }]);
        }
        const row = perTable.find((p) => p.table === table.name);
        if (row !== undefined) {
          row.deep = true;
          // The archive is the authority once read: what the parts hold minus what is missing is what the selection accounts for.
          const missing = deep.drifts.find((d) => d.kind === 'missing_rows');
          row.foreign = Math.max(0, row.keyed - (deep.distinct - (missing ? (missing.expected ?? 0) - (missing.actual ?? 0) : 0)));
        }
      }
    }
  } catch (err) {
    if (isMsmError(err, 'interrupted') || ctx.signal.aborted) return interrupted();
    throw err;
  } finally {
    await releaseLock();
  }

  const exitCode = exitFor(ctx.signal, drifts, ignore);
  const counted = drifts.filter((d) => !ignore.has(d.kind)).length;
  info(exitCode === exitCodes.ok && drifts.length === 0 ? `no drift in ${formatCount(perTable.length)} tables` : `${formatCount(counted)} drifts (${formatCount(drifts.length - counted)} ignored) in ${formatCount(perTable.length)} tables`);
  return { drifts, exitCode, perTable };
}
