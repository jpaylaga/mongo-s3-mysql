import { createReadStream } from 'node:fs';
import { chmod, mkdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'mysql2';
import type { SqlValue } from 'mysql2';
import type { ResultSetHeader } from 'mysql2/promise';
import readGzipLines from '#ejson/readGzipLines';
import createBatcher from '#load/createBatcher';
import downloadPart from '#load/downloadPart';
import partPath from '#load/partPath';
import writeBatch from '#load/writeBatch';
import transformLine from '#mapping/transformLine';
import toSafeNumber from '#mysql/toSafeNumber';
import upsertSql from '#mysql/upsertSql';
import errorMessage from '#runtime/errorMessage';
import formatCount from '#runtime/formatCount';
import msmError from '#runtime/msmError';
import tempDirOf from '#runtime/tempDirOf';
import withRetry from '#runtime/withRetry';
import type {
  BatchTally,
  ChunkOutcome,
  LoadBatch,
  LoadCandidate,
  LoadRun,
  LoadTarget,
  RejectResult,
  RowResult,
} from '#types';

interface LedgerState {
  id: number;
  status: 'loading' | 'loaded' | 'failed';
  linesDone: number;
  manifestSha256: string;
  mappingSha256: string;
}

/** Reset deletes run in pages so a chunk with millions of key rows does not hold one giant lock. */
const deletePage = 10_000;
/** The lock check must answer fast; a stalled socket here means the lock is as good as lost. */
const lockCheckTimeoutMs = 30_000;

/**
 * The GET_LOCK holder must still own the table lock, or another loader may be writing the same
 * rows. A query that fails or stalls on that connection means the server dropped it, and with it
 * the lock: fatal, not a retry. The connection is destroyed on failure, so the ping and the release
 * do not queue behind a command the socket will never answer.
 */
async function assertLockHeld(run: LoadRun, table: string): Promise<void> {
  const lock = run.locks.get(table);

  if (lock === undefined)
    throw msmError('lock', `lock on ${table} was never taken`, { fatal: true });

  let held: unknown;

  try {
    const [rows] = await lock.conn.query(
      { sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', timeout: lockCheckTimeoutMs },
      [lock.name]
    );

    held = (rows as { held?: unknown }[])[0]?.held;
  } catch (err) {
    lock.destroy();

    throw msmError('lock', `lock on ${table} lost: ${errorMessage(err)}`, {
      fatal: true,
      cause: err,
    });
  }

  if (Number(held) !== 1) {
    lock.destroy();

    throw msmError('lock', `lock on ${table} lost`, { fatal: true });
  }
}

async function readState(run: LoadRun, table: string, runId: string): Promise<LedgerState> {
  const [rows] = await withRetry(run.ctx, { source: 'mysql', name: `ledger ${runId}` }, () =>
    run.mysql.pool.query(
      'SELECT `id`, `status`, `lines_done`, `manifest_sha256`, `mapping_sha256` ' +
        'FROM `_msm_load_chunks` WHERE `target_table` = ? AND `chunk_run_id` = ?',
      [table, runId]
    )
  );

  const row = (rows as Record<string, unknown>[])[0];

  if (row === undefined)
    throw msmError('mysql', `${runId}: ledger row missing after registration`, { fatal: true });

  return {
    id: toSafeNumber(row.id, '_msm_load_chunks.id'),
    status: row.status as LedgerState['status'],
    linesDone: toSafeNumber(row.lines_done, '_msm_load_chunks.lines_done'),
    manifestSha256: String(row.manifest_sha256),
    mappingSha256: String(row.mapping_sha256),
  };
}

/**
 * The reset of a chunk's ledger state: counters to zero, then the chunk's rejects and key rows, in
 * pages.
 */
async function resetState(
  run: LoadRun,
  state: LedgerState,
  manifestSha256: string,
  mappingSha256: string,
  runId: string
): Promise<void> {
  const retry = <T>(name: string, fn: () => Promise<T>) =>
    withRetry(run.ctx, { source: 'mysql', name: `${name} ${runId}` }, fn);

  await retry('reset', () =>
    run.mysql.pool.query(
      'UPDATE `_msm_load_chunks` SET `lines_done` = 0, `rows_inserted` = 0, ' +
        '`rows_updated` = 0, `duplicates_skipped` = 0, `rows_rejected` = 0, ' +
        ("`cast_errors` = 0, `status` = 'loading', `manifest_sha256` = ?, " +
          '`mapping_sha256` = ?, `finished_at` = NULL, `error` = NULL, ') +
        '`updated_at` = UTC_TIMESTAMP(3) WHERE `id` = ?',
      [manifestSha256, mappingSha256, state.id]
    )
  );

  const tables = [
    '_msm_load_rejects',
    ...(run.ctx.config.load.keyLedger ? ['_msm_load_keys'] : []),
  ];

  for (const table of tables) {
    for (;;) {
      const [header] = await retry(`delete ${table}`, () =>
        run.mysql.pool.query(
          `DELETE FROM \`${table}\` WHERE \`chunk_id\` = ? LIMIT ${deletePage}`,
          [state.id]
        )
      );

      if ((header as ResultSetHeader).affectedRows < deletePage) break;
    }
  }
}

const addTally = (sum: BatchTally, t: BatchTally): void => {
  sum.inserted += t.inserted;
  sum.updated += t.updated;
  sum.duplicates += t.duplicates;
  sum.rejected += t.rejected;
  sum.castErrors += t.castErrors;
};

/**
 * One attempt at one chunk: check the table lock, register or find the ledger row, reset it when
 * the manifest or mapping changed, when the candidate says `reload` (`--reload`, or the order guard
 * forcing a newer chunk to replay after an older batch) or when nothing was committed yet, then
 * stream every part through transform, batcher and `writeBatch`, skipping the lines a previous
 * attempt already committed. The ledger row is the only state; a throw leaves it at its last
 * committed `lines_done` for the next attempt. A reload is reset once: the candidate's `reload` is
 * cleared after the reset, so a later attempt resumes from `lines_done` instead of replaying the
 * lines the first attempt committed.
 */
export default async function loadChunk(
  run: LoadRun,
  cand: LoadCandidate,
  attempt: number
): Promise<ChunkOutcome> {
  const { ctx } = run;
  const { resolved } = cand;
  const { runId, collection, manifest } = resolved;
  const target: LoadTarget | undefined = run.targets.get(collection);

  if (target === undefined)
    throw msmError('config', `${collection}: no load target`, { fatal: true });

  const table = target.table.name;
  const mappingSha256 = target.loaded.sha256;

  const outcome = (
    status: ChunkOutcome['status'],
    extra: Partial<ChunkOutcome> = {}
  ): ChunkOutcome => ({ chunk: runId, collection, status, ...extra });

  const retry = <T>(name: string, fn: () => Promise<T>) =>
    withRetry(ctx, { source: 'mysql', name: `${name} ${runId}` }, fn);

  const startedAt = ctx.now();

  ctx.emit({
    type: 'chunk',
    command: ctx.command,
    chunk: runId,
    status: 'start',
    detail: attempt > 1 ? `attempt ${attempt}` : undefined,
  });

  await assertLockHeld(run, table);

  const batchCutoff = run.batchCutoffs.get(resolved.batchId) ?? null;

  await retry('register', () =>
    run.mysql.pool.query(
      'INSERT IGNORE INTO `_msm_load_chunks` (`target_table`, `collection`, ' +
        '`batch_id`, `chunk_run_id`, `batch_cutoff_utc`, `manifest_key`, ' +
        ('`manifest_sha256`, `mapping_sha256`, `exported_count`, `load_run_id`, ' +
          '`started_at`, `updated_at`) ') +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
      [
        table,
        collection,
        resolved.batchId,
        runId,
        batchCutoff,
        resolved.key,
        resolved.sha256,
        mappingSha256,
        manifest.exported_count,
        run.loadRunId,
      ]
    )
  );

  let state = await readState(run, table, runId);

  if (state.status === 'loaded' && !cand.reload) {
    ctx.emit({
      type: 'chunk',
      command: ctx.command,
      chunk: runId,
      status: 'skipped',
      detail: 'already loaded',
    });

    return outcome('skipped', { note: 'already loaded' });
  }

  const changed = state.manifestSha256 !== resolved.sha256 || state.mappingSha256 !== mappingSha256;

  if (cand.reload || changed || state.linesDone === 0) {
    // A row at lines_done 0 always runs the deletes, so an interrupted reset completes on the next
    // attempt.
    await resetState(run, state, resolved.sha256, mappingSha256, runId);

    state = {
      ...state,
      status: 'loading',
      linesDone: 0,
      manifestSha256: resolved.sha256,
      mappingSha256,
    };

    // Once reset, the obligation is met: the next attempt (or a forced replay's) continues at the
    // committed lines_done.
    cand.reload = false;
  }

  // The attempt stamp also refreshes what INSERT IGNORE left from the first registration: a
  // re-exported chunk's count, its manifest key, and a cutoff that was unknown then (the order
  // guard skips rows without one).
  await retry('attempt', () =>
    run.mysql.pool.query(
      "UPDATE `_msm_load_chunks` SET `status` = 'loading', `attempts` = `attempts` " +
        '+ 1, `load_run_id` = ?, `manifest_sha256` = ?, `mapping_sha256` = ?, ' +
        ('`exported_count` = ?, `manifest_key` = ?, `batch_cutoff_utc` = ' +
          'COALESCE(?, `batch_cutoff_utc`), `error` = NULL, `updated_at` = ' +
          'UTC_TIMESTAMP(3) WHERE `id` = ?'),
      [
        run.loadRunId,
        resolved.sha256,
        mappingSha256,
        manifest.exported_count,
        resolved.key,
        batchCutoff,
        state.id,
      ]
    )
  );

  const ledgerId = state.id;
  const linesDone = state.linesDone;

  const tc = {
    mapping: target.loaded.mapping,
    table: target.table,
    children: target.children,
    loadRunId: run.loadRunId,
    ledgerId,
  };

  const { head, tail } = upsertSql(table, target.columns, target.loaded.mapping.key.column);

  const rejectTuple = (r: RejectResult) =>
    format('(?,?,?,?,UTC_TIMESTAMP(3))', [ledgerId, r.lineNo, r.reason, r.text]);

  // Child tuples are formatted once here: the batcher budgets them and writeBatch sends them.
  const childTuples = (r: RowResult): Map<string, string[]> =>
    new Map(
      [...r.children].map(([child, rows]) => [
        child,
        rows.map(values => format('(?)', [values as SqlValue[]])),
      ])
    );

  const batcher = createBatcher({
    maxRows: ctx.config.load.batchRows,
    maxBytes: run.maxBatchBytes,
    maxRowBytes: run.maxRowBytes,
    fixedBytes: Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8'),
    rejectTuple,
  });

  const tally: BatchTally = { inserted: 0, updated: 0, duplicates: 0, rejected: 0, castErrors: 0 };

  const flush = async (batch: LoadBatch | null): Promise<void> => {
    if (batch === null) return;

    if (ctx.signal.aborted) throw msmError('interrupted', `${runId}: interrupted`);

    addTally(tally, await writeBatch(run, target, ledgerId, batch));
  };

  const dir = join(tempDirOf(ctx.config, 'load'), runId);

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  let linesRead = 0;

  try {
    for (const [i, part] of resolved.parts.entries()) {
      if (ctx.signal.aborted) throw msmError('interrupted', `${runId}: interrupted`);

      const partLines = part.lines ?? manifest.exported_count;

      if (linesRead + partLines <= linesDone) {
        linesRead += partLines;

        continue;
      }

      const path = partPath(dir, i);

      await downloadPart(run.store, part, path, ctx.config.minFreeDiskMb);

      try {
        for await (const text of readGzipLines(createReadStream(path))) {
          linesRead += 1;

          const lineNo = linesRead;

          if (lineNo <= linesDone) continue;

          const item = transformLine(text, lineNo, tc);

          const tuple =
            item.kind === 'row' ? format('(?)', [item.values as SqlValue[]]) : rejectTuple(item);

          await flush(
            batcher.add(item, tuple, lineNo, item.kind === 'row' ? childTuples(item) : undefined)
          );
        }
      } finally {
        await unlink(path).catch(() => undefined);
      }

      ctx.emit({
        type: 'chunk',
        command: ctx.command,
        chunk: runId,
        status: 'part',
        detail: `${part.name} ${formatCount(linesRead)} lines read`,
      });
    }

    await flush(batcher.drain());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (linesRead !== manifest.exported_count) {
    throw msmError(
      'record',
      `${runId}: read ${formatCount(linesRead)} lines, manifest says ` +
        `exported_count ${formatCount(manifest.exported_count)}`
    );
  }

  await retry('finish', () =>
    run.mysql.pool.query(
      "UPDATE `_msm_load_chunks` SET `status` = 'loaded', `error` = NULL, " +
        '`finished_at` = UTC_TIMESTAMP(3), `updated_at` = UTC_TIMESTAMP(3) WHERE ' +
        '`id` = ?',
      [ledgerId]
    )
  );

  const applied = manifest.exported_count - linesDone;
  const seconds = ((ctx.now().getTime() - startedAt.getTime()) / 1000).toFixed(1);

  const detail =
    resolved.parts.length === 0
      ? 'no documents, ledger only'
      : `${formatCount(applied)} lines: ${formatCount(tally.inserted)} inserted, ` +
        `${formatCount(tally.updated)} updated, ${formatCount(tally.rejected)} ` +
        `rejected${linesDone > 0 ? ` (resumed at ${formatCount(linesDone)})` : ''} ` +
        `(${seconds}s)`;

  ctx.emit({ type: 'chunk', command: ctx.command, chunk: runId, status: 'done', detail });

  return outcome('done', { docs: applied });
}
